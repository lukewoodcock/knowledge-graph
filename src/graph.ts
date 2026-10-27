import { promises as fs } from 'fs';
import * as path from 'path';
import { listMarkdownFiles, parseNote } from './vault';
import { isNote, isSessionLog, linkTargets, noteName, NoteRef, noteRefFields } from './vault-format';

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

/** A linked note, described enough to decide whether to open it. */
export interface LinkedNote extends NoteRef {
  title: string;
}

/** The notes one note links to (outgoing) and the notes linking to it (incoming). */
export interface RelatedNotes {
  name: string;
  outgoing: LinkedNote[];
  incoming: LinkedNote[];
}

/**
 * The notes linked to and from the named note, or null when there is none.
 * Links to notes that don't exist are left out, as are session logs and the
 * note itself.
 */
export async function relatedNotes(vaultPath: string, name: string): Promise<RelatedNotes | null> {
  const paths = (await notePaths(vaultPath)).filter(p => !isSessionLog(p));
  const notes = new Map<string, { note: LinkedNote; links: string[] }>();
  for (const relPath of paths) {
    const n = noteName(relPath);
    if (notes.has(n)) continue; // same rule as readNote: the first path wins
    const content = await fs.readFile(path.join(vaultPath, relPath), 'utf8');
    const { frontmatter } = parseNote(content);
    notes.set(n, {
      note: {
        name: n,
        path: relPath,
        title: frontmatter.title || n,
        ...noteRefFields(frontmatter),
      },
      links: linkTargets(content),
    });
  }

  const self = notes.get(name);
  if (!self) return null;
  const outgoing = self.links
    .filter(target => target !== name)
    .flatMap(target => {
      const linked = notes.get(target);
      return linked ? [linked.note] : [];
    });
  const incoming = [...notes.values()]
    .filter(n => n.note.name !== name && n.links.includes(name))
    .map(n => n.note);
  return { name, outgoing, incoming };
}
