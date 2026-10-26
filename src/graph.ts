import { promises as fs } from 'fs';
import * as path from 'path';
import { listMarkdownFiles, parseNote } from './vault';

/**
 * Reading the graph by name: one note in full, and the notes linked to and
 * from it. A note's name is its file name without `.md`, as a link names it.
 * Reads go straight to the vault, which stays the only source of truth.
 */

/** One note in full. */
export interface NoteView {
  name: string;
  /** Path relative to the vault root, e.g. "memos/cache-decision.md". */
  path: string;
  /** Top-level frontmatter fields, as parseNote reads them. */
  frontmatter: Record<string, string>;
  /** The note's markdown after its frontmatter. */
  content: string;
}

/** Dot folders (.obsidian, .trash, the index) don't hold notes. */
function isNote(relPath: string): boolean {
  return !relPath.split('/').some(seg => seg.startsWith('.'));
}

function noteName(relPath: string): string {
  return path.basename(relPath, '.md');
}

async function notePaths(vaultPath: string): Promise<string[]> {
  return (await listMarkdownFiles(vaultPath)).filter(isNote);
}

/**
 * The note with this name, or null when there is none. Names are matched
 * against the vault's own files, so a name can never reach outside it.
 * Two notes sharing a name in different folders: the first path wins.
 */
export async function readNote(vaultPath: string, name: string): Promise<NoteView | null> {
  const relPath = (await notePaths(vaultPath)).find(p => noteName(p) === name);
  if (!relPath) return null;
  const { frontmatter, body } = parseNote(await fs.readFile(path.join(vaultPath, relPath), 'utf8'));
  return { name, path: relPath, frontmatter, content: body.replace(/^(\r?\n)+/, '') };
}
