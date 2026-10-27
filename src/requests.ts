/**
 * Validation of the bodies the service's endpoints accept. Pure functions:
 * each takes the parsed JSON body and returns what the endpoint works with,
 * or an error message for a 400.
 */
import { MAX_SEARCH_LIMIT } from './embedding-index';

/** The string, trimmed, when it holds anything but whitespace; else undefined. */
export function trimmedString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export const MEMO_KINDS = ['learning', 'decision', 'todo', 'snippet', 'conversation'] as const;

/** What sort of memo it is. */
export type MemoKind = (typeof MEMO_KINDS)[number];

function isMemoKind(v: string | undefined): v is MemoKind {
  return (MEMO_KINDS as readonly string[]).includes(v ?? '');
}

/** A memo as the session's agent sent it, validated. */
export interface Memo {
  kind: MemoKind;
  title: string;
  body: string;
  project: string;
  session: string;
  files: string[];
}

/** Most memos one request can carry. */
export const MAX_MEMOS = 20;

/**
 * The memos in a memo request, not yet validated: one memo object, a JSON
 * array of them, or `{ "memos": [...] }`.
 */
export function memoList(body: unknown): unknown {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object' && 'memos' in body) return (body as { memos: unknown }).memos;
  return [body];
}

/**
 * Validates one memo. Returns the memo, or the problems with it, each
 * naming the field as `memos[i].<field>`.
 */
function parseMemo(raw: unknown, i: number): Memo | string[] {
  const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const at = `memos[${i}]`;
  const problems: string[] = [];

  const kind = trimmedString(m.kind);
  if (!isMemoKind(kind)) problems.push(`${at}.kind must be one of: ${MEMO_KINDS.join(', ')}`);
  const title = trimmedString(m.title);
  const body = trimmedString(m.body);
  const project = trimmedString(m.project);
  const session = trimmedString(m.session_id);
  for (const [name, value] of Object.entries({ title, body, project, session_id: session })) {
    if (!value) problems.push(`${at}.${name} is required`);
  }
  const files = m.files ?? [];
  const validFiles = Array.isArray(files) && files.every(f => typeof f === 'string');
  if (!validFiles) problems.push(`${at}.files must be a list of file paths`);

  if (!isMemoKind(kind) || !title || !body || !project || !session || !validFiles) return problems;
  return {
    kind,
    // One line, so it can't break the session log or a heading.
    title: title.replace(/\s+/g, ' '),
    body,
    project,
    session,
    files: files.map(f => f.trim()).filter(f => f !== ''),
  };
}

/** The memos in a memo request (see memoList). Any invalid memo rejects the whole request. */
export function parseMemos(body: unknown): { memos: Memo[] } | { error: string } {
  const raw = memoList(body);
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

/** The filters a search can narrow its results with, each with an example for its error. */
const SEARCH_FILTERS = { type: 'code', kind: 'todo', status: 'open' } as const;

type SearchFilter = keyof typeof SEARCH_FILTERS;

/** A search request, validated. A filter left out (or sent blank or null) is undefined. */
export type SearchRequest = { query: string; limit?: number } & Partial<Record<SearchFilter, string>>;

/**
 * The search in a search request: a non-empty query, an optional limit, and
 * optional filters: the note's type (code, memo), a memo's kind (todo,
 * decision...) and the note's status (open).
 */
export function parseSearch(body: unknown): SearchRequest | { error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const query = trimmedString(b.query);
  if (!query) return { error: 'Payload must include a non-empty query' };
  const limit = b.limit;
  if (limit !== undefined && !(typeof limit === 'number' && Number.isInteger(limit) && limit > 0)) {
    return { error: `limit must be a whole number from 1 to ${MAX_SEARCH_LIMIT}` };
  }
  const search: SearchRequest = { query, limit };
  for (const [filter, example] of Object.entries(SEARCH_FILTERS) as Array<[SearchFilter, string]>) {
    const value = b[filter];
    // Blank or null means no filter.
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return { error: `${filter} must be a string, e.g. "${example}"` };
    }
    const trimmed = trimmedString(value);
    if (trimmed) search[filter] = trimmed;
  }
  return search;
}
