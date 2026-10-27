import { promises as fs } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { Config } from './config';
import { embed } from './ollama';
import { listMarkdownFiles, parseNote } from './vault';
import { isRecallable, isResearch, LINK_SECTION_HEADINGS, noteName, NoteRef, noteRefFields, vaultRelative } from './vault-format';

/**
 * The embedding index: every note's sections embedded with Ollama, kept in
 * one file inside the vault. The notes stay the only source of truth
 * (ADR 0001): the file can be deleted at any time and rebuilt from them.
 */
export interface EmbeddingIndex {
  /**
   * Embeds the given notes (absolute paths, or relative to the vault) when
   * they are missing from the index or have changed since; a path whose file
   * is gone is dropped from the index.
   */
  indexNotes(notePaths: string[]): Promise<void>;
  /** Indexes every note that is missing or changed, and drops deleted ones. */
  sync(): Promise<IndexSummary>;
  /** Throws the index away and embeds every note again. */
  rebuild(): Promise<IndexSummary>;
  /** Ranks notes by their best section's similarity to the query. */
  search(query: string, options?: SearchOptions): Promise<SearchHit[]>;
}

export interface IndexSummary {
  /** Notes in the index afterwards. */
  notes: number;
  /** Notes embedded by this call. */
  embedded: number;
  /** Notes dropped because their file is gone. */
  removed: number;
}

export interface SearchOptions {
  /** Most results to return; DEFAULT_SEARCH_LIMIT when left out. */
  limit?: number;
  /** Only notes of this type, e.g. "code" or "memo". */
  type?: string;
  /** Only memos of this kind, e.g. "todo". */
  kind?: string;
  /** Only notes with this status, e.g. "open" for open todos. */
  status?: string;
}

export interface SearchHit extends NoteRef {
  /** The note's `status` (a todo's is "open" until it's closed by hand), or null. */
  status: string | null;
  /** The best-matching section, shortened to SNIPPET_LENGTH characters. */
  snippet: string;
  /** Cosine similarity of the best-matching section to the query. */
  score: number;
}

export const DEFAULT_SEARCH_LIMIT = 5;
export const MAX_SEARCH_LIMIT = 50;
const SNIPPET_LENGTH = 300;

/** Where the index lives, relative to the vault root. Obsidian hides dot folders. */
export const INDEX_FILE = path.join('.swarm-kg', 'index.json');
// 2: type, kind and status kept apart, and research decided by the note's type alone.
const INDEX_VERSION = 2;

interface IndexedSection {
  /** The section (or one chunk of a long one) as written in the note, heading included. */
  text: string;
  vector: number[];
}

interface IndexedNote {
  hash: string;
  type: string | null;
  kind: string | null;
  status: string | null;
  project: string | null;
  /** True for the Researcher's notes, which recall leaves out. */
  research: boolean;
  sections: IndexedSection[];
}

interface IndexFile {
  version: number;
  model: string;
  /** Keyed by path relative to the vault root, "/"-separated. */
  notes: Record<string, IndexedNote>;
}

/** Headings (lower case) of the sections that only list links. */
const LINK_SECTIONS = LINK_SECTION_HEADINGS.map(h => h.toLowerCase());

/**
 * Splits a note body into its `##` sections. Text before the first `##`
 * heading is a section of its own. `##` lines inside code fences don't
 * start a section, and link lists (the Linker's "Related Notes", a memo's
 * "Same Session") are left out: link names would make the note match
 * queries about the notes it links to.
 */
export function splitSections(body: string): Array<{ heading: string; text: string }> {
  const sections: Array<{ heading: string; lines: string[] }> = [{ heading: '', lines: [] }];
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && /^## /.test(line)) sections.push({ heading: line.slice(3).trim(), lines: [] });
    sections[sections.length - 1].lines.push(line);
  }
  return sections
    .map(s => ({ heading: s.heading, text: s.lines.join('\n').trim() }))
    .filter(s => s.text !== '' && !LINK_SECTIONS.includes(s.heading.toLowerCase()));
}

/**
 * Most characters of section text in one embed input. bge-large reads 512
 * tokens and silently drops the rest; at roughly 3 to 4 characters a token
 * this leaves room for the context prefix. Ollama's own truncation stays on
 * as a backstop for token-dense text such as code.
 */
export const CHUNK_CHARS = 1500;

/** Splits text into pieces of at most `max` characters, at whitespace where it can. */
function hardSplit(text: string, max: number): string[] {
  const pieces: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const cut = rest.lastIndexOf(' ', max);
    const at = cut > 0 ? cut : max;
    pieces.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/**
 * Splits a section too long to embed whole into chunks of at most
 * CHUNK_CHARS, at paragraph breaks where it can. Every chunk after the first
 * starts with the section's heading, so it still says where it came from.
 */
export function chunkSection(heading: string, text: string): string[] {
  if (text.length <= CHUNK_CHARS) return [text];
  const label = heading ? `## ${heading.substring(0, 100)}\n` : '';
  const budget = CHUNK_CHARS - label.length;
  const pieces = text.split(/\n\s*\n/).flatMap(p => hardSplit(p, budget));

  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + 2 + piece.length > budget) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks.map((c, i) => (i === 0 || c.startsWith(label) ? c : label + c));
}

/** First line of prose in a text: not a heading, not blank. */
function firstLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map(l => l.trim())
    .find(l => l !== '' && !l.startsWith('#'));
}

/**
 * The one-line summary in front of every section: the frontmatter's
 * `summary` if the note has one, else the first line of its "Summary"
 * section, else the first line of prose in the note.
 */
function summaryLine(
  frontmatter: Record<string, string>,
  sections: Array<{ heading: string; text: string }>,
): string | undefined {
  const line =
    frontmatter.summary ||
    firstLine(sections.find(s => s.heading.toLowerCase() === 'summary')?.text ?? '') ||
    firstLine(sections.map(s => s.text).join('\n'));
  return line?.substring(0, 200);
}

/**
 * The context prefix put in front of each section before it's embedded
 * (contextual chunks), so a section like "Key Points" still matches
 * questions about the note's topic.
 */
export function contextPrefix(ctx: {
  title: string;
  type: string | null;
  kind: string | null;
  project: string | null;
  summary?: string;
}): string {
  return [
    `Note: ${ctx.title.substring(0, 120)}`,
    ...(ctx.type ? [`Type: ${ctx.type.substring(0, 40)}`] : []),
    ...(ctx.kind ? [`Kind: ${ctx.kind.substring(0, 40)}`] : []),
    ...(ctx.project ? [`Project: ${ctx.project.substring(0, 80)}`] : []),
    ...(ctx.summary ? [`Summary: ${ctx.summary}`] : []),
  ].join('\n');
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function snippet(text: string): string {
  return text.length <= SNIPPET_LENGTH ? text : text.substring(0, SNIPPET_LENGTH - 1).trimEnd() + '…';
}

function emptyIndex(model: string): IndexFile {
  return { version: INDEX_VERSION, model, notes: {} };
}

export function createEmbeddingIndex(cfg: Config): EmbeddingIndex {
  const indexPath = path.join(cfg.vaultPath, INDEX_FILE);
  let loaded: IndexFile | undefined;
  // Every operation runs after the previous one settles, so a run indexing
  // its notes, a startup sync and a search never interleave on the file.
  let queue: Promise<unknown> = Promise.resolve();

  function exclusive<T>(op: () => Promise<T>): Promise<T> {
    const result = queue.then(op);
    queue = result.catch(() => undefined);
    return result;
  }

  /** The index file, or an empty index if it's missing, unreadable or for another model. */
  async function load(): Promise<IndexFile> {
    if (loaded) return loaded;
    try {
      const parsed = JSON.parse(await fs.readFile(indexPath, 'utf8')) as IndexFile;
      const usable = parsed.version === INDEX_VERSION && parsed.model === cfg.embedModel && parsed.notes;
      loaded = usable ? parsed : emptyIndex(cfg.embedModel);
    } catch {
      loaded = emptyIndex(cfg.embedModel);
    }
    return loaded;
  }

  /** Writes the index atomically, so a crash mid-write can't leave half a file. */
  async function save(index: IndexFile): Promise<void> {
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    const tmp = `${indexPath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(index), 'utf8');
    await fs.rename(tmp, indexPath);
  }

  async function embedNote(relPath: string, content: string, hash: string): Promise<IndexedNote> {
    const { frontmatter, body } = parseNote(content);
    const name = noteName(relPath);
    const ref = noteRefFields(frontmatter);
    const sections = splitSections(body);
    const prefix = contextPrefix({ title: frontmatter.title || name, ...ref, summary: summaryLine(frontmatter, sections) });
    // A note with no body is still findable by its title and context.
    const texts = sections.length > 0 ? sections.flatMap(s => chunkSection(s.heading, s.text)) : [''];
    const vectors = await embed(
      cfg.ollamaUrl,
      cfg.embedModel,
      texts.map(t => (t ? `${prefix}\n\n${t}` : prefix)),
    );
    return {
      hash,
      ...ref,
      status: frontmatter.status || null,
      research: isResearch(frontmatter),
      sections: texts.map((text, i) => ({ text, vector: vectors[i] })),
    };
  }

  /**
   * Brings one note's entry up to date. Returns 'embedded', 'removed' or
   * 'unchanged'.
   */
  async function refresh(index: IndexFile, relPath: string): Promise<'embedded' | 'removed' | 'unchanged'> {
    let content: string;
    try {
      content = await fs.readFile(path.join(cfg.vaultPath, relPath), 'utf8');
    } catch {
      if (!(relPath in index.notes)) return 'unchanged';
      delete index.notes[relPath];
      return 'removed';
    }
    const hash = createHash('sha256').update(content).digest('hex');
    if (index.notes[relPath]?.hash === hash) return 'unchanged';
    index.notes[relPath] = await embedNote(relPath, content, hash);
    return 'embedded';
  }

  /** Refreshes every note in the vault into `index` and drops entries for deleted notes. */
  async function syncInto(index: IndexFile): Promise<IndexSummary> {
    const relPaths = (await listMarkdownFiles(cfg.vaultPath)).filter(isRecallable);
    const present = new Set(relPaths);
    let embedded = 0;
    let removed = 0;
    for (const relPath of Object.keys(index.notes)) {
      if (!present.has(relPath)) {
        delete index.notes[relPath];
        removed++;
      }
    }
    for (const relPath of relPaths) {
      if ((await refresh(index, relPath)) === 'embedded') embedded++;
    }
    return { notes: Object.keys(index.notes).length, embedded, removed };
  }

  return {
    indexNotes: notePaths =>
      exclusive(async () => {
        const index = await load();
        let changed = false;
        for (const relPath of notePaths.map(p => vaultRelative(cfg.vaultPath, p)).filter(isRecallable)) {
          if ((await refresh(index, relPath)) !== 'unchanged') changed = true;
        }
        if (changed) await save(index);
      }),

    sync: () =>
      exclusive(async () => {
        const index = await load();
        const summary = await syncInto(index);
        if (summary.embedded > 0 || summary.removed > 0) await save(index);
        return summary;
      }),

    rebuild: () =>
      exclusive(async () => {
        // Built aside and swapped in only once complete, so a failed rebuild
        // leaves the previous index in place.
        const fresh = emptyIndex(cfg.embedModel);
        const summary = await syncInto(fresh);
        await save(fresh);
        loaded = fresh;
        return { ...summary, removed: 0 };
      }),

    search: (query, options = {}) =>
      exclusive(async () => {
        const index = await load();
        const limit = Math.min(options.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
        const [queryVector] = await embed(cfg.ollamaUrl, cfg.embedModel, [query]);

        const hits: SearchHit[] = [];
        for (const [relPath, note] of Object.entries(index.notes)) {
          if (note.research) continue;
          if (options.type !== undefined && note.type !== options.type) continue;
          if (options.kind !== undefined && note.kind !== options.kind) continue;
          if (options.status !== undefined && note.status !== options.status) continue;
          let best: IndexedSection | undefined;
          let bestScore = -Infinity;
          for (const section of note.sections) {
            const score = cosine(queryVector, section.vector);
            if (score > bestScore) {
              bestScore = score;
              best = section;
            }
          }
          if (!best) continue;
          hits.push({
            name: noteName(relPath),
            path: relPath,
            type: note.type,
            kind: note.kind,
            status: note.status,
            project: note.project,
            snippet: snippet(best.text),
            score: bestScore,
          });
        }
        return hits.sort((a, b) => b.score - a.score).slice(0, limit);
      }),
  };
}
