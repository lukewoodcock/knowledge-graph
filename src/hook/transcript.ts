// Pure parsing of a Claude Code transcript (JSONL, one event per line).
// We only care about the last turn: the latest real user prompt and the
// file-editing tool calls Claude made after it.

export const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const;
export type EditTool = (typeof EDIT_TOOLS)[number];

export interface FileEdit {
  tool: EditTool;
  filePath: string;
  /** New text from the tool input; the fallback when git has no diff. */
  content: string;
}

export interface Turn {
  prompt: string;
  /** In call order; a file edited twice appears twice (see uniqueFiles). */
  edits: FileEdit[];
}

interface ContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
}

interface TranscriptLine {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: { content?: string | ContentBlock[] };
}

// User lines that look like prompts but are harness output, not something
// the user asked for.
const NON_PROMPT_PREFIXES = [
  '[Request interrupted',
  '<local-command-stdout>',
  '<local-command-caveat>',
  '<bash-stdout>',
  '<bash-stderr>',
];

function parseLine(raw: string): TranscriptLine | null {
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as TranscriptLine) : null;
  } catch {
    return null; // a half-written last line, or junk: ignore it
  }
}

function blocks(line: TranscriptLine): ContentBlock[] {
  const c = line.message?.content;
  return Array.isArray(c) ? c : [];
}

/** Slash commands are logged as <command-name>/x</command-name><command-args>..; render as "/x args". */
function renderCommand(text: string): string {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim();
  if (!name) return text;
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}

/** Returns the prompt text if this line is a real user prompt, else null. */
export function promptText(line: TranscriptLine): string | null {
  if (line.type !== 'user' || line.isMeta || line.isSidechain) return null;
  const c = line.message?.content;

  let text: string;
  if (typeof c === 'string') {
    text = c;
  } else if (Array.isArray(c)) {
    if (c.some(b => b.type === 'tool_result')) return null;
    text = c
      .filter(b => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n');
  } else {
    return null;
  }

  text = text.trim();
  if (!text || NON_PROMPT_PREFIXES.some(p => text.startsWith(p))) return null;
  return renderCommand(text).trim() || null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Turns an edit tool_use block into a FileEdit, or null if it isn't one. */
export function toFileEdit(block: ContentBlock): FileEdit | null {
  if (block.type !== 'tool_use' || !EDIT_TOOLS.includes(block.name as EditTool)) return null;
  const tool = block.name as EditTool;
  const input = block.input ?? {};

  const filePath = str(tool === 'NotebookEdit' ? input.notebook_path : input.file_path);
  if (!filePath) return null;

  let content: string;
  switch (tool) {
    case 'Write':
      content = str(input.content);
      break;
    case 'Edit':
      content = str(input.new_string);
      break;
    case 'MultiEdit':
      content = Array.isArray(input.edits)
        ? input.edits.map(e => str((e as Record<string, unknown>)?.new_string)).join('\n…\n')
        : '';
      break;
    case 'NotebookEdit':
      content = str(input.new_source);
      break;
  }
  return { tool, filePath, content };
}

/**
 * Extracts the last turn from a transcript: everything after the final real
 * user prompt. Scans backwards so a long session only parses its tail.
 * Edits whose tool_result was an error (denied, old_string not found) are
 * dropped. Returns null when there's no prompt at all.
 */
export function extractLastTurn(jsonl: string): Turn | null {
  const lines = jsonl.split('\n');
  const failed = new Set<string>();
  const edits: Array<FileEdit & { id?: string }> = [];

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = parseLine(lines[i]);
    if (!line) continue;

    const prompt = promptText(line);
    if (prompt !== null) {
      const ok = edits.filter(e => !e.id || !failed.has(e.id)).reverse();
      return { prompt, edits: ok.map(({ id: _id, ...e }) => e) };
    }

    // Skip subagent lines: their edits belong to the subagent's own run.
    if (line.isSidechain) continue;

    for (const b of blocks(line)) {
      if (line.type === 'user' && b.type === 'tool_result' && b.is_error && b.tool_use_id) {
        failed.add(b.tool_use_id);
      }
      if (line.type === 'assistant') {
        const edit = toFileEdit(b);
        if (edit) edits.push({ ...edit, id: b.id });
      }
    }
  }
  return null;
}

/**
 * One entry per file, in first-seen order. Several edits to one file have
 * their new text joined, so the no-git fallback still shows all of it.
 */
export function uniqueFiles(edits: FileEdit[]): FileEdit[] {
  const byPath = new Map<string, FileEdit>();
  for (const e of edits) {
    const prev = byPath.get(e.filePath);
    byPath.set(e.filePath, prev ? { ...e, content: `${prev.content}\n…\n${e.content}` } : e);
  }
  return [...byPath.values()];
}
