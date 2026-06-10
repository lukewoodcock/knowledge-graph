import { promises as fs } from 'fs';
import * as path from 'path';

/** Returns today's date as YYYY-MM-DD. */
export function today(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Sanitises arbitrary text into a filesystem-safe title: non-alphanumeric
 * characters (except _ - .) become underscores, leading/trailing underscores
 * are stripped, and the result is truncated to maxLen characters.
 */
export function safeTitle(input: string, maxLen = 60): string {
  return input
    .replace(/[^a-zA-Z0-9_\-.]/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, maxLen);
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
