import * as path from 'path';

/**
 * The vault's format: the facts every note writer and every reader agree
 * on. Writers (the agents, memo runs, the session log) and readers (the
 * graph reads, the embedding index) both take them from here, so the read
 * side never depends on how one source writes its notes (ADR 0001).
 * Pure: no file system access.
 */

/** The folders the service writes notes into, relative to the vault root. */
export const FOLDERS = {
  code: 'code',
  research: 'research',
  memos: 'memos',
  logs: 'logs',
} as const;

export type Folder = keyof typeof FOLDERS;

/** The full path of the note with this name in one of the service's folders. */
export function notePath(vaultPath: string, folder: Folder, name: string): string {
  return path.join(vaultPath, FOLDERS[folder], `${name}.md`);
}

/** A path relative to the vault root, "/"-separated, from an absolute or vault-relative one. */
export function vaultRelative(vaultPath: string, notePathOrRel: string): string {
  const abs = path.resolve(vaultPath, notePathOrRel);
  return path.relative(vaultPath, abs).split(path.sep).join('/');
}

/** A note's name: its file name without `.md`, as a link names it. */
export function noteName(relPath: string): string {
  return path.basename(relPath, '.md');
}

/** Dot folders (.obsidian, .trash, the index) don't hold notes. */
export function isNote(relPath: string): boolean {
  return !relPath.split(/[/\\]/).some(seg => seg.startsWith('.'));
}

/** Session logs record every capture; they're never recalled, linked or a link target. */
export function isSessionLog(relPath: string): boolean {
  return relPath.startsWith(`${FOLDERS.logs}/`);
}

/** The notes recall reads and the Linker may link to: every note except the session logs. */
export function isRecallable(relPath: string): boolean {
  return isNote(relPath) && !isSessionLog(relPath);
}

/** The heading of the section where the service lists a memo's same-session links. */
export const SESSION_LINKS_HEADING = 'Same Session';

/** The heading of the section where the Linker lists a note's similarity links. */
export const RELATED_LINKS_HEADING = 'Related Notes';

/** Headings of the sections that only list links. */
export const LINK_SECTION_HEADINGS = [SESSION_LINKS_HEADING, RELATED_LINKS_HEADING];

/** The note a wikilink points at: "[[name|alias]]", "[[name#heading]]" or "name|alias" -> "name". */
export function wikilinkTarget(link: string): string {
  return link.replace(/^\[\[/, '').replace(/\]\]$/, '').split(/[|#]/)[0].trim();
}

function wikilinks(text: string): string[] {
  return [...text.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => wikilinkTarget(m[1])).filter(n => n !== '');
}

/** The note names a note's `[[wikilinks]]` point at, in order, without repeats. */
export function linkTargets(content: string): string[] {
  return [...new Set(wikilinks(content))];
}

/** Link targets listed under a note's `## <heading>` section, in order. */
export function sectionLinks(content: string, heading: string): string[] {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex(l => l.trim() === `## ${heading}`);
  if (start < 0) return [];
  const links: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2} /.test(line)) break;
    links.push(...wikilinks(line));
  }
  return links;
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

/** The name of the Documenter's note for a code capture. */
export function codeNoteName(date: string, filePath: string): string {
  return `${date}_${safeTitle(filePath || 'unknown')}`;
}

/** The name of the Researcher's note for a code capture. */
export function researchNoteName(date: string, topic: string): string {
  return `${date}_research_${safeTitle(topic || 'unknown')}`;
}

/** The name a memo's note gets, before any number that makes it unique. */
export function memoNoteName(date: string, title: string): string {
  return `${date}_${safeTitle(title) || 'memo'}`;
}

/** The name of the day's session log. */
export function sessionLogName(date: string): string {
  return `${date}_session_log`;
}
