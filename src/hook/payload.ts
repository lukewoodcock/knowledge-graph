// Pure pieces of the Stop hook: config, skip rules, and webhook payloads.
import * as path from 'path';
import { FileEdit, Turn, uniqueFiles } from './transcript';
import { positiveInt } from '../env';

/** The subset of the Stop hook stdin JSON we use. */
export interface StopHookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  /** The session's scratchpad (Claude Code 2.1.257+): temporary files, never project work. */
  scratchpad_dir?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean;
}

/** Same shape the webhook accepts (see src/server.ts). */
export interface WebhookPayload {
  file_path: string;
  language: string;
  description: string;
  changed_code: string;
  /** The Claude Code session the turn belongs to. */
  session_id?: string;
  /** The project the session works in (see projectName in io.ts). */
  project?: string;
}

export interface HookConfig {
  url: string;
  disabled: boolean;
  vaultPath?: string;
  timeoutMs: number;
  maxFiles: number;
  maxCodeChars: number;
  maxDescriptionChars: number;
  debug: boolean;
}

export const DEFAULT_URL = 'http://localhost:5678/webhook/knowledge-graph/trigger';

export function loadHookConfig(env: NodeJS.ProcessEnv = process.env): HookConfig {
  return {
    url: env.KG_URL || DEFAULT_URL,
    disabled: env.KG_DISABLE === '1',
    vaultPath: env.KG_VAULT_PATH || undefined,
    timeoutMs: positiveInt(env.KG_TIMEOUT_MS, 2000),
    maxFiles: positiveInt(env.KG_MAX_FILES, 5),
    maxCodeChars: 4000,
    maxDescriptionChars: 1000,
    debug: env.KG_DEBUG === '1',
  };
}

/** True if `child` is `parent` or somewhere below it. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Why the hook should do nothing, or null to proceed. */
export function skipReason(input: StopHookInput, cfg: HookConfig): string | null {
  if (cfg.disabled) return 'KG_DISABLE=1';
  if (input.stop_hook_active) return 'stop_hook_active';
  if (input.hook_event_name && input.hook_event_name !== 'Stop') return `event ${input.hook_event_name}`;
  if (!input.transcript_path) return 'no transcript_path';
  // Feedback loop guard: a Claude session working in the vault itself.
  if (cfg.vaultPath && input.cwd && isInside(input.cwd, cfg.vaultPath)) return 'cwd is inside the vault';
  return null;
}

const LANGUAGES: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust', '.java': 'java',
  '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala', '.sc': 'scala', '.swift': 'swift',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp', '.cs': 'csharp',
  '.php': 'php', '.sh': 'bash', '.bash': 'bash', '.zsh': 'zsh', '.sql': 'sql',
  '.html': 'html', '.css': 'css', '.scss': 'scss', '.vue': 'vue', '.svelte': 'svelte',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.xml': 'xml',
  '.md': 'markdown', '.ipynb': 'python', '.tf': 'terraform', '.lua': 'lua',
  '.ex': 'elixir', '.exs': 'elixir', '.hs': 'haskell', '.dart': 'dart', '.r': 'r',
};

const FILENAMES: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
};

export function languageFromPath(filePath: string): string {
  const base = path.basename(filePath).toLowerCase();
  return FILENAMES[base] ?? LANGUAGES[path.extname(base)] ?? 'unknown';
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

/** Path relative to the project when the file is inside it, so notes get readable titles. */
export function displayPath(filePath: string, projectDir?: string): string {
  if (!projectDir || !path.isAbsolute(filePath) || !isInside(filePath, projectDir)) return filePath;
  return path.relative(projectDir, filePath);
}

/** Where the session works, which decides which edited files are code captures. */
export interface CaptureScope {
  /** The session's project root; files outside it are never captured. */
  projectDir?: string;
  /** The session's scratchpad (temporary files, such as /remember's memos file). */
  scratchpadDir?: string;
}

/**
 * One payload per changed file (deduped, capped at cfg.maxFiles), all
 * sharing the turn's prompt as the description, each path relative to the
 * project. `diffs` maps a file path to its git diff; files without one fall
 * back to the tool input's new text. Only files inside the project become
 * captures (see changedFiles). Each payload carries the session id and
 * project when they're known.
 */
export function buildPayloads(
  turn: Turn,
  opts: CaptureScope & {
    diffs?: Map<string, string>;
    cfg: HookConfig;
    sessionId?: string;
    project?: string;
  },
): WebhookPayload[] {
  const { diffs, cfg, sessionId, project, projectDir } = opts;
  const description = truncate(turn.prompt, cfg.maxDescriptionChars);

  return changedFiles(turn, cfg, opts)
    .map((e: FileEdit) => ({
      file_path: displayPath(e.filePath, projectDir),
      language: languageFromPath(e.filePath),
      description,
      changed_code: truncate(diffs?.get(e.filePath) || e.content, cfg.maxCodeChars),
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(project ? { project } : {}),
    }));
}

/**
 * The files a turn changed that we'd report on, before any diffs are fetched.
 * Only files inside the session's project count: Claude also edits files
 * elsewhere, such as its own memory files under ~/.claude/projects/, and
 * those aren't the project's code. Files in the vault or the session's
 * scratchpad are left out too: the scratchpad holds temporary files, such as
 * the memos file the /remember skill writes there before sending it.
 */
export function changedFiles(turn: Turn, cfg: HookConfig, scope: CaptureScope = {}): FileEdit[] {
  const { projectDir, scratchpadDir } = scope;
  return uniqueFiles(turn.edits)
    .filter(e => !projectDir || isInside(e.filePath, projectDir))
    .filter(e => !(cfg.vaultPath && isInside(e.filePath, cfg.vaultPath)))
    .filter(e => !(scratchpadDir && isInside(e.filePath, scratchpadDir)))
    .slice(0, cfg.maxFiles);
}
