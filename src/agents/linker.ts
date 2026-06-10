import { promises as fs } from 'fs';
import * as path from 'path';
import { Config } from '../config';
import { chat } from '../ollama';
import { listMarkdownFiles } from '../vault';
import { LinkerResult, NoteResult } from '../types';

const SYSTEM_PROMPT =
  'You are a knowledge-graph linking assistant. Your job is to find meaningful ' +
  'connections between notes in an Obsidian vault and output ONLY a JSON array — ' +
  'no prose, no markdown fences, no explanation.';

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
  if (content.includes('## Related Notes')) return null;
  const section = `\n\n## Related Notes\n${links.map(l => `- ${l}`).join('\n')}\n`;
  return content + section;
}

/** Builds the "- [[basename]] (relative/path.md)" index for the prompt. */
export function buildNoteIndex(relativePaths: string[]): string {
  return relativePaths
    .map(f => {
      const base = f.replace(/^.*\//, '').replace(/\.md$/, '');
      return `- [[${base}]] (${f})`;
    })
    .join('\n');
}

function userPrompt(indexString: string, newNotes: NoteResult[], language: string, description: string): string {
  const notesJson = JSON.stringify(
    newNotes.map(n => ({ path: n.notePath, title: n.title, type: n.agent })),
  );
  return `Below is a list of existing notes in the vault (wikilink format):

${indexString}

New notes just added:
${notesJson}

Context of the current work session:
Language: ${language}
Description: ${description}

Task: For EACH new note, identify up to 5 existing notes that are semantically related. Return a JSON array with this structure (no markdown fences):
[
  {
    "new_note_path": "<full path of new note>",
    "links_to_add": ["[[ExistingNote1]]", "[[ExistingNote2]]"]
  }
]

If no meaningful links exist, return an empty links_to_add array for that note. Output ONLY the JSON array.`;
}

/**
 * Scans the vault for existing notes, asks the LLM for semantic links to the
 * newly created notes, and appends [[wikilink]] sections to them.
 */
export async function runLinker(
  newNotes: NoteResult[],
  language: string,
  description: string,
  cfg: Config,
): Promise<LinkerResult> {
  if (newNotes.length === 0) {
    return { agent: 'linker', status: 'success', linksWritten: 0 };
  }

  const existing = await listMarkdownFiles(cfg.vaultPath);
  const indexString = buildNoteIndex(existing);

  const raw = await chat(cfg.ollamaUrl, cfg.ollamaModel, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt(indexString, newNotes, language, description) },
  ]);

  const linkMap = parseLinkMap(raw);
  let linksWritten = 0;

  for (const entry of linkMap) {
    // Only touch files inside the vault that we actually just created —
    // never write to arbitrary paths the LLM invents.
    const target = newNotes.find(n => n.notePath === entry.new_note_path);
    if (!target) continue;

    const fullPath = path.resolve(target.notePath);
    let content: string;
    try {
      content = await fs.readFile(fullPath, 'utf8');
    } catch {
      continue;
    }

    const updated = appendLinks(content, entry.links_to_add);
    if (updated === null) continue;

    await fs.writeFile(fullPath, updated, 'utf8');
    linksWritten++;
  }

  return { agent: 'linker', status: 'success', linksWritten };
}
