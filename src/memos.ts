import { promises as fs } from 'fs';
import * as path from 'path';
import { Config } from './config';
import { safeTitle, writeNote } from './vault';

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
    title: fields.title!,
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

function renderMemo(memo: Memo, date: string): string {
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
  ];
  const frontmatter = ['---', ...fields.map(([k, v]) => `${k}: ${v}`), '---'].join('\n');
  return `${frontmatter}\n\n${memo.body.trim()}\n`;
}

/** Writes one memo into the memos folder. */
export async function writeMemo(memo: Memo, date: string, cfg: Config): Promise<MemoNote> {
  const notePath = await freeNotePath(cfg, date, memo.title);
  await writeNote(notePath, renderMemo(memo, date));
  return { memo, notePath, name: path.basename(notePath, '.md') };
}
