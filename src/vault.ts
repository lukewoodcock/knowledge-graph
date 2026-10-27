import { promises as fs } from 'fs';
import * as path from 'path';

/** Returns today's date as YYYY-MM-DD. */
export function today(): string {
  return new Date().toISOString().split('T')[0];
}

export interface Frontmatter {
  title: string;
  date: string;
  tags: string[];
  related: string[];
  source: string;
  type: 'code' | 'research' | 'log';
}

/** Renders YAML frontmatter in the vault's standard shape. */
export function renderFrontmatter(fm: Frontmatter): string {
  return [
    '---',
    `title: "${fm.title.replace(/"/g, "'")}"`,
    `date: ${fm.date}`,
    `tags: [${fm.tags.join(', ')}]`,
    `related: [${fm.related.join(', ')}]`,
    `source: "${fm.source}"`,
    `type: "${fm.type}"`,
    '---',
  ].join('\n');
}

/**
 * Adds `key: "value"` lines to a note's YAML frontmatter, skipping undefined
 * values. A note without frontmatter gets a block holding just these fields.
 */
export function addFrontmatterFields(
  content: string,
  fields: Record<string, string | undefined>,
): string {
  const lines = Object.entries(fields)
    .filter((e): e is [string, string] => e[1] !== undefined)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  if (lines.length === 0) return content;

  // Everything up to (not including) the closing "---" line.
  const fm = /^---\r?\n[\s\S]*?\r?\n(?=---[ \t]*(\r?\n|$))/.exec(content);
  if (!fm) return ['---', ...lines, '---', '', content].join('\n');
  const end = fm[0].length;
  return content.slice(0, end) + lines.join('\n') + '\n' + content.slice(end);
}

/** A note split into its frontmatter fields and its body. */
export interface ParsedNote {
  /** Top-level `key: value` frontmatter fields, quotes removed. */
  frontmatter: Record<string, string>;
  /** Everything after the frontmatter block. */
  body: string;
}

/** Strips surrounding double or single quotes from a YAML scalar. */
function unquote(value: string): string {
  if (/^".*"$/.test(value)) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (/^'.*'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

/**
 * Splits a note into frontmatter and body. Only flat `key: value` lines are
 * read, which is all the vault's notes use; lists stay as their raw text
 * (e.g. "[a, b]"). A note without frontmatter has none and keeps its whole
 * content as the body.
 */
export function parseNote(content: string): ParsedNote {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!m) return { frontmatter: {}, body: content };
  const frontmatter: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*?)\s*$/.exec(line);
    if (kv) frontmatter[kv[1]] = unquote(kv[2]);
  }
  return { frontmatter, body: content.slice(m[0].length) };
}

/** The frontmatter fields a note written from a capture carries. */
export function captureFields(ctx: { project?: string; session?: string }): Record<string, string | undefined> {
  return { project: ctx.project, session: ctx.session };
}

/** Writes a note, creating parent directories as needed. */
export async function writeNote(fullPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf8');
}

/** Appends to a file, creating it (and parent dirs) if missing. */
export async function appendNote(fullPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.appendFile(fullPath, content, 'utf8');
}

/**
 * Recursively lists all .md files under the vault, returned as paths
 * relative to the vault root (e.g. "code/2026-06-10_foo.md").
 */
export async function listMarkdownFiles(vaultPath: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(vaultPath, { recursive: true })) as string[];
  } catch {
    return [];
  }
  return entries
    .map(e => e.split(path.sep).join('/'))
    .filter(e => e.endsWith('.md'))
    .sort();
}
