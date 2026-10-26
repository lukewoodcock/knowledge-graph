// Pure pieces of the Stop hook: config, skip rules, and webhook payloads.
import * as path from 'path';
import { FileEdit, Turn, uniqueFiles } from './transcript';

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

function int(v: string | undefined, fallback: number): number {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadHookConfig(env: NodeJS.ProcessEnv = process.env): HookConfig {
  return {
    url: env.SWARM_KG_URL || DEFAULT_URL,
    disabled: env.SWARM_KG_DISABLE === '1',
    vaultPath: env.SWARM_KG_VAULT_PATH || undefined,
    timeoutMs: int(env.SWARM_KG_TIMEOUT_MS, 2000),
    maxFiles: int(env.SWARM_KG_MAX_FILES, 5),
    maxCodeChars: 4000,
    maxDescriptionChars: 1000,
    debug: env.SWARM_KG_DEBUG === '1',
  };
}

/** True if `child` is `parent` or somewhere below it. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Why the hook should do nothing, or null to proceed. */
export function skipReason(input: StopHookInput, cfg: HookConfig): string | null {
  if (cfg.disabled) return 'SWARM_KG_DISABLE=1';
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

/** Path relative to cwd when the file is inside it, so notes get readable titles. */
export function displayPath(filePath: string, cwd?: string): string {
  if (!cwd || !path.isAbsolute(filePath) || !isInside(filePath, cwd)) return filePath;
  return path.relative(cwd, filePath);
}

/**
 * One payload per changed file (deduped, capped at cfg.maxFiles), all
 * sharing the turn's prompt as the description. `diffs` maps a file path to
 * its git diff; files without one fall back to the tool input's new text.
 * Files inside the vault or the session's scratchpad are left out. Each
 * payload carries the session id and project when they're known.
 */
export function buildPayloads(
  turn: Turn,
  opts: {
    cwd?: string;
    diffs?: Map<string, string>;
    cfg: HookConfig;
    sessionId?: string;
    project?: string;
    scratchpadDir?: string;
  },
): WebhookPayload[] {
  const { cwd, diffs, cfg, sessionId, project, scratchpadDir } = opts;
  const description = truncate(turn.prompt, cfg.maxDescriptionChars);

  return changedFiles(turn, cfg, scratchpadDir)
    .map((e: FileEdit) => ({
      file_path: displayPath(e.filePath, cwd),
      language: languageFromPath(e.filePath),
      description,
      changed_code: truncate(diffs?.get(e.filePath) || e.content, cfg.maxCodeChars),
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(project ? { project } : {}),
    }));
}

/**
 * The files a turn changed that we'd report on, before any diffs are fetched.
 * Files in the session's scratchpad are left out: they're temporary, such as
 * the memos file the /remember skill writes there before sending it.
 */
export function changedFiles(turn: Turn, cfg: HookConfig, scratchpadDir?: string): FileEdit[] {
  return uniqueFiles(turn.edits)
    .filter(e => !(cfg.vaultPath && isInside(e.filePath, cfg.vaultPath)))
    .filter(e => !(scratchpadDir && isInside(e.filePath, scratchpadDir)))
    .slice(0, cfg.maxFiles);
}
