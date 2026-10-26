import { promises as fs } from 'fs';
import * as path from 'path';
import { Config } from './config';
import { listMarkdownFiles, parseNote, safeTitle, writeNote } from './vault';

/** A memo as the session's agent sent it, validated. */
export interface Memo {
  kind: string;
  title: string;
  body: string;
  project: string;
  session: string;
  files: string[];
}

/** One memo's note once a run has written it. */
export interface MemoNote {
  memo: Memo;
  notePath: string;
  /** The note's name: its file name without `.md`, as a link names it. */
  name: string;
  /** Names of the code-capture notes from the memo's session that it links to. */
  sessionLinks: string[];
}

export const MEMO_KINDS = ['learning', 'decision', 'todo', 'snippet', 'conversation'] as const;

/** Most memos one request can carry. */
export const MAX_MEMOS = 20;

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Validates one memo. Returns the memo, or the problems with it, each
 * naming the field as `memos[i].<field>`.
 */
function parseMemo(raw: unknown, i: number): Memo | string[] {
  const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const at = `memos[${i}]`;
  const problems: string[] = [];

  const kind = text(m.kind);
  if (!kind || !(MEMO_KINDS as readonly string[]).includes(kind)) {
    problems.push(`${at}.kind must be one of: ${MEMO_KINDS.join(', ')}`);
  }
  const fields = { title: text(m.title), body: text(m.body), project: text(m.project), session_id: text(m.session_id) };
  for (const [name, value] of Object.entries(fields)) {
    if (!value) problems.push(`${at}.${name} is required`);
  }
  const files = m.files ?? [];
  const validFiles = Array.isArray(files) && files.every(f => typeof f === 'string');
  if (!validFiles) problems.push(`${at}.files must be a list of file paths`);

  if (problems.length > 0) return problems;
  return {
    kind: kind!,
    // One line, so it can't break the session log or a heading.
    title: fields.title!.replace(/\s+/g, ' '),
    body: fields.body!,
    project: fields.project!,
    session: fields.session_id!,
    files: (files as string[]).map(f => f.trim()).filter(f => f !== ''),
  };
}

/**
 * The memos in a memo request: one memo object, a JSON array of them, or
 * `{ "memos": [...] }`. Any invalid memo rejects the whole request.
 */
export function parseMemos(body: unknown): { memos: Memo[] } | { error: string } {
  const raw = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && 'memos' in body
      ? (body as { memos: unknown }).memos
      : [body];
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'Payload must include at least one memo' };
  if (raw.length > MAX_MEMOS) return { error: `At most ${MAX_MEMOS} memos per request` };

  const memos: Memo[] = [];
  const problems: string[] = [];
  raw.forEach((r, i) => {
    const parsed = parseMemo(r, i);
    if (Array.isArray(parsed)) problems.push(...parsed);
    else memos.push(parsed);
  });
  return problems.length > 0 ? { error: problems.join('; ') } : { memos };
}

/** A free path for a memo's note: `memos/<date>_<title>.md`, numbered if taken. */
async function freeNotePath(cfg: Config, date: string, title: string): Promise<string> {
  const base = `${date}_${safeTitle(title) || 'memo'}`;
  for (let n = 1; ; n++) {
    const candidate = path.join(cfg.vaultPath, 'memos', `${n === 1 ? base : `${base}_${n}`}.md`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
}

/** The heading of the section holding a memo's same-session links. */
export const SESSION_LINKS_HEADING = 'Same Session';

/**
 * Names of the notes code captures wrote in each session, keyed by session.
 * Memos, session logs and dot folders are left out.
 */
async function codeNotesBySession(cfg: Config): Promise<Map<string, string[]>> {
  const bySession = new Map<string, string[]>();
  const relPaths = (await listMarkdownFiles(cfg.vaultPath)).filter(
    p => !p.startsWith('memos/') && !p.startsWith('logs/') && !p.split('/').some(seg => seg.startsWith('.')),
  );
  for (const relPath of relPaths) {
    let content: string;
    try {
      content = await fs.readFile(path.join(cfg.vaultPath, relPath), 'utf8');
    } catch {
      continue;
    }
    const session = parseNote(content).frontmatter.session;
    if (!session) continue;
    bySession.set(session, [...(bySession.get(session) ?? []), path.basename(relPath, '.md')]);
  }
  return bySession;
}

function renderMemo(memo: Memo, date: string, sessionLinks: string[]): string {
  const fields: Array<[string, string]> = [
    ['title', JSON.stringify(memo.title)],
    ['date', date],
    ['tags', `[memo, ${memo.kind}]`],
    ['related', '[]'],
    ['source', JSON.stringify('memo')],
    ['type', JSON.stringify('memo')],
    ['kind', JSON.stringify(memo.kind)],
    ['project', JSON.stringify(memo.project)],
    ['session', JSON.stringify(memo.session)],
    // Closed by editing the note in Obsidian.
    ...(memo.kind === 'todo' ? [['status', JSON.stringify('open')] as [string, string]] : []),
    ...(memo.files.length > 0 ? [['files', `[${memo.files.map(f => JSON.stringify(f)).join(', ')}]`] as [string, string]] : []),
  ];
  const frontmatter = ['---', ...fields.map(([k, v]) => `${k}: ${v}`), '---'].join('\n');
  const links =
    sessionLinks.length > 0
      ? `\n\n## ${SESSION_LINKS_HEADING}\n${sessionLinks.map(l => `- [[${l}]]`).join('\n')}`
      : '';
  return `${frontmatter}\n\n${memo.body}${links}\n`;
}

/** Link targets listed under a `## <heading>` section of a note. */
function sectionLinks(content: string, heading: string): string[] {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex(l => l.trim() === `## ${heading}`);
  if (start < 0) return [];
  const links: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2} /.test(line)) break;
    for (const m of line.matchAll(/\[\[([^\]|#]+)[^\]]*\]\]/g)) links.push(m[1].trim());
  }
  return links;
}

/**
 * Every note a memo links to as written now: its session links, then the
 * Linker's similarity links, each name once.
 */
export async function memoLinks(note: MemoNote): Promise<string[]> {
  let similar: string[] = [];
  try {
    similar = sectionLinks(await fs.readFile(note.notePath, 'utf8'), 'Related Notes');
  } catch {
    // Gone since the run wrote it; the session links are still what was written.
  }
  return [...new Set([...note.sessionLinks, ...similar])];
}

/**
 * Writes each memo into the memos folder, linked to every note the code
 * captures of its session wrote. These links are the service's, not the
 * Linker's: they hold whatever the Linker makes of the memo.
 */
export async function writeMemos(memos: Memo[], date: string, cfg: Config): Promise<MemoNote[]> {
  const bySession = await codeNotesBySession(cfg);
  const written: MemoNote[] = [];
  for (const memo of memos) {
    const sessionLinks = bySession.get(memo.session) ?? [];
    const notePath = await freeNotePath(cfg, date, memo.title);
    await writeNote(notePath, renderMemo(memo, date, sessionLinks));
    written.push({ memo, notePath, name: path.basename(notePath, '.md'), sessionLinks });
  }
  return written;
}
