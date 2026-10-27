import { promises as fs } from 'fs';
import * as path from 'path';
import { Config } from '../config';
import { chat } from '../ollama';
import { parseNote } from '../vault';
import { noteName, RELATED_LINKS_HEADING, vaultRelative, wikilinkTarget } from '../vault-format';
import { CHUNK_CHARS, EmbeddingIndex, SearchHit } from '../embedding-index';
import { LinkerResult, WrittenNote } from '../types';

const SYSTEM_PROMPT =
  'You are a knowledge-graph linking assistant. Your job is to find meaningful ' +
  'connections between notes in an Obsidian vault and output ONLY a JSON array — ' +
  'no prose, no markdown fences, no explanation.';

/** How many of the most similar notes each new note is offered as link candidates. */
export const LINK_CANDIDATES = 10;

export interface LinkMapEntry {
  new_note_path: string;
  links_to_add: string[];
}

/**
 * Parses the LLM's link-map response, stripping accidental markdown fences.
 * Returns [] on any parse failure (graceful degradation — a bad LLM response
 * should never fail the whole run).
 */
export function parseLinkMap(raw: string): LinkMapEntry[] {
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/\s*```$/, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(e => e && typeof e.new_note_path === 'string')
      .map(e => ({
        new_note_path: e.new_note_path,
        links_to_add: Array.isArray(e.links_to_add) ? e.links_to_add : [],
      }));
  } catch {
    return [];
  }
}

/**
 * Appends a "## Related Notes" section with the given wikilinks.
 * Returns null when there is nothing to do (no links, or section already present).
 */
export function appendLinks(content: string, links: string[]): string | null {
  if (links.length === 0) return null;
  if (content.includes(`## ${RELATED_LINKS_HEADING}`)) return null;
  const section = `\n\n## ${RELATED_LINKS_HEADING}\n${links.map(l => `- ${l}`).join('\n')}\n`;
  return content + section;
}

/**
 * Keeps only the links the LLM suggests to one of the note's candidates, so
 * a run never writes a link to a note that doesn't exist, to the note
 * itself, or to a session log (none of which are ever candidates). Each
 * target is linked once.
 */
export function filterLinks(links: string[], candidateNames: string[]): string[] {
  const seen = new Set<string>();
  return links.filter(l => {
    if (typeof l !== 'string') return false;
    const target = wikilinkTarget(l);
    if (!candidateNames.includes(target) || seen.has(target)) return false;
    seen.add(target);
    return true;
  });
}

/** Builds the "- [[basename]] (relative/path.md)" index for the prompt. */
export function buildNoteIndex(relativePaths: string[]): string {
  return relativePaths
    .map(f => `- [[${noteName(f)}]] (${f})`)
    .join('\n');
}

/** A new note with the existing notes it may link to. */
interface NoteToLink {
  note: WrittenNote;
  content: string;
  candidates: SearchHit[];
}

/** The note-as-query the Linker searches with: its title and body, cut to one embed input. */
function searchText(content: string, fallbackTitle: string): string {
  const { frontmatter, body } = parseNote(content);
  return `${frontmatter.title || fallbackTitle}\n\n${body.trim()}`.substring(0, CHUNK_CHARS);
}

function userPrompt(toLink: NoteToLink[], language: string, description: string): string {
  const notes = toLink
    .map(n =>
      [
        `### New note: ${n.note.notePath}`,
        `Title: ${n.note.title}`,
        `Type: ${n.note.type}`,
        'Candidates (most similar first):',
        buildNoteIndex(n.candidates.map(c => c.path)),
      ].join('\n'),
    )
    .join('\n\n');
  return `Below are the notes just added to the vault, each with the existing notes most similar to it (its link candidates, in wikilink format):

${notes}

Context of the current work session:
Language: ${language}
Description: ${description}

Task: For EACH new note, choose up to 5 of ITS OWN candidates that are semantically related. Never choose a note that is not in its candidate list. Return a JSON array with this structure (no markdown fences), writing each link as a wikilink to the candidate's name:
[
  {
    "new_note_path": "<full path of new note>",
    "links_to_add": ["<wikilink>", "<wikilink>"]
  }
]

If no meaningful links exist, return an empty links_to_add array for that note. Output ONLY the JSON array.`;
}

/**
 * Links the newly created notes into the graph. Each new note is offered the
 * LINK_CANDIDATES existing notes most similar to it, found by searching the
 * embedding index with the note's own text; the LLM picks the related ones,
 * and [[wikilink]] sections are appended to the new notes.
 *
 * The new notes need not be in the index yet: the search embeds their text
 * as the query. That's why a run indexes its notes after the Linker, once,
 * with the links in place. Search never returns session logs or research
 * notes, and a note is never its own candidate, even when an earlier version
 * of it at the same path is already indexed.
 */
export interface LinkerInput {
  /** The notes the run just wrote. */
  notes: WrittenNote[];
  /** The work the notes came from, for the prompt: the capture's language and description. */
  language: string;
  description: string;
  cfg: Config;
  index: Pick<EmbeddingIndex, 'search'>;
}

export async function runLinker({ notes, language, description, cfg, index }: LinkerInput): Promise<LinkerResult> {
  const toLink: NoteToLink[] = [];
  for (const note of notes) {
    let content: string;
    try {
      content = await fs.readFile(path.resolve(note.notePath), 'utf8');
    } catch {
      continue;
    }
    const self = vaultRelative(cfg.vaultPath, note.notePath);
    const hits = await index.search(searchText(content, note.title), { limit: LINK_CANDIDATES + 1 });
    const candidates = hits.filter(h => h.path !== self).slice(0, LINK_CANDIDATES);
    if (candidates.length > 0) toLink.push({ note, content, candidates });
  }

  // Nothing to link to (an empty or tiny vault): no need to ask the LLM.
  if (toLink.length === 0) {
    return { agent: 'linker', status: 'success', linksWritten: 0 };
  }

  const raw = await chat(cfg.ollamaUrl, cfg.ollamaModel, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt(toLink, language, description) },
  ], cfg.ollamaThink);

  let linksWritten = 0;
  for (const entry of parseLinkMap(raw)) {
    // Only touch the notes we just created, never arbitrary paths the LLM
    // invents.
    const target = toLink.find(n => n.note.notePath === entry.new_note_path);
    if (!target) continue;

    const links = filterLinks(entry.links_to_add, target.candidates.map(c => c.name));
    const updated = appendLinks(target.content, links);
    if (updated === null) continue;

    await fs.writeFile(path.resolve(target.note.notePath), updated, 'utf8');
    target.content = updated;
    linksWritten++;
  }

  return { agent: 'linker', status: 'success', linksWritten };
}
