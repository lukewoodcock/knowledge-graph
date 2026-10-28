// Side effects shared by the hooks and /remember: reading stdin, asking git
// for diffs and the project's root and name, and posting code captures.
// Every function here resolves rather than throws, so a failure can never
// reach Claude.
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
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
 * Files in the project's git working tree that differ from HEAD or are new
 * (git-ignored ones left out) and were last modified at or after `since`, as
 * absolute paths. Deleted files are left out, since there's nothing to read.
 * [] outside a repo or when git is slow.
 */
export async function filesChangedSince(projectDir: string, since: Date, timeoutMs = 1000): Promise<string[]> {
  const status = await new Promise<string>(resolve => {
    execFile(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { cwd: projectDir, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(err ? '' : stdout),
    );
  });

  // Entries are "XY path", NUL-separated; a rename or copy is followed by
  // its old path as an entry of its own.
  const paths: string[] = [];
  const entries = status.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    if (xy.includes('R') || xy.includes('C')) i++;
    if (xy.includes('D')) continue;
    paths.push(path.join(projectDir, entry.slice(3)));
  }

  const changed = await Promise.all(
    paths.map(async p => {
      try {
        return (await fs.stat(p)).mtimeMs >= since.getTime() ? p : null;
      } catch {
        return null;
      }
    }),
  );
  return changed.filter((p): p is string => p !== null);
}

/** A text file's contents, or '' when it's missing, over `maxBytes`, or binary. */
export async function readText(filePath: string, maxBytes = 256 * 1024): Promise<string> {
  try {
    if ((await fs.stat(filePath)).size > maxBytes) return '';
    const text = await fs.readFile(filePath, 'utf8');
    return text.includes('\0') ? '' : text;
  } catch {
    return '';
  }
}

/**
 * The root of the project a directory belongs to: the top of its git
 * working tree (a linked worktree's own folder), or the directory itself
 * outside one (or when git is slow).
 */
export function projectRoot(dir: string, timeoutMs = 1000): Promise<string> {
  const fallback = path.resolve(dir);
  return new Promise(resolve => {
    execFile('git', ['rev-parse', '--show-toplevel'], { cwd: dir, timeout: timeoutMs }, (err, stdout) =>
      resolve(err || !stdout.trim() ? fallback : stdout.trim()),
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
