// Side effects for the Stop hook: stdin, git, HTTP. Every function here
// resolves rather than throws, so a failure can never reach Claude.
import { execFile } from 'child_process';
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
