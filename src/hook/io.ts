// Side effects for the Stop hook: stdin, git, HTTP. Every function here
// resolves rather than throws, so a failure can never reach Claude.
import { execFile } from 'child_process';
import * as path from 'path';
import { WebhookPayload } from './payload';

export function readStdin(timeoutMs: number): Promise<string> {
  return new Promise(resolve => {
    let data = '';
    const done = () => resolve(data);
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => (data += chunk));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      done();
    });
    process.stdin.on('error', done);
  });
}

/**
 * Uncommitted changes to one file vs HEAD (staged + unstaged), or '' when
 * there's no repo, the file is untracked, or git is slow.
 */
export function gitDiff(cwd: string, filePath: string, timeoutMs = 1000): Promise<string> {
  return new Promise(resolve => {
    execFile(
      'git',
      ['diff', '--no-color', '--no-ext-diff', 'HEAD', '--', filePath],
      { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(err ? '' : stdout),
    );
  });
}

/**
 * The project a working directory belongs to: the name of its git
 * repository, or the directory's own name outside one (or when git is slow).
 * Uses the repository's common git dir, so a linked worktree is named after
 * the main repository rather than the worktree's folder.
 */
export function projectName(cwd: string, timeoutMs = 1000): Promise<string> {
  const fallback = path.basename(path.resolve(cwd));
  return new Promise(resolve => {
    execFile(
      'git',
      ['rev-parse', '--show-toplevel', '--git-common-dir'],
      { cwd, timeout: timeoutMs },
      (err, stdout) => {
        if (err) return resolve(fallback);
        const [toplevel, commonDir] = stdout.trim().split('\n');
        if (!toplevel || !commonDir) return resolve(fallback);
        const common = path.resolve(cwd, commonDir);
        // A normal repo or a linked worktree: <repo>/.git. Anything else
        // (a submodule's .git/modules/x, say) goes by its top-level folder.
        const repoDir = path.basename(common) === '.git' ? path.dirname(common) : toplevel;
        resolve(path.basename(repoDir) || fallback);
      },
    );
  });
}

export async function postPayload(
  url: string,
  payload: WebhookPayload,
  timeoutMs: number,
): Promise<string> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return `${res.status} ${payload.file_path}`;
  } catch (err) {
    return `failed ${payload.file_path}: ${String(err)}`;
  }
}
