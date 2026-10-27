// The capture hook through its entrypoint: hook JSON on stdin in, code
// captures POSTed to the service out. Runs the real hook against a real git
// repo in a temp dir, with a local server standing in for the service.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { projectName } from '../src/hook/io';
import { listen } from './helpers/mock-ollama';

const HOOK = path.join(__dirname, '..', 'src', 'hook', 'stop.ts');

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });

async function makeRepo(parent: string, name: string): Promise<string> {
  const dir = path.join(parent, name);
  await fs.mkdir(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

/** Runs the hook with `input` on stdin and an env free of the developer's own SWARM_KG_* settings. */
function runHook(input: object, env: Record<string, string>): Promise<number | null> {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SWARM_KG_') && k !== 'CLAUDE_PROJECT_DIR'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', HOOK], {
      env: { ...clean, ...env },
      stdio: ['pipe', 'ignore', 'inherit'],
    });
    child.on('error', reject);
    child.on('exit', resolve);
    child.stdin.end(JSON.stringify(input));
  });
}

/** A transcript whose last turn writes each of `files`. */
async function writeTranscript(dir: string, files: string[]): Promise<string> {
  const lines = [
    { type: 'user', message: { role: 'user', content: 'Add the greeting module' } },
    ...files.map((f, i) => ({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Write', input: { file_path: f, content: `// ${i}` } }] },
    })),
  ];
  const p = path.join(dir, 'transcript.jsonl');
  await fs.writeFile(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

describe('projectName', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-project-')));
  });

  test('is the git repository name at its root and in a subdirectory', async () => {
    const repo = await makeRepo(tmp, 'project-a');
    await fs.mkdir(path.join(repo, 'src', 'deep'), { recursive: true });

    expect(await projectName(repo)).toBe('project-a');
    expect(await projectName(path.join(repo, 'src', 'deep'))).toBe('project-a');
  });

  test('is the main repository name inside a linked worktree', async () => {
    const repo = await makeRepo(tmp, 'project-a');
    const wt = path.join(tmp, 'elsewhere', 'agent-123');
    git(repo, 'worktree', 'add', '-q', wt);

    expect(await projectName(wt)).toBe('project-a');
  });

  test('falls back to the directory name outside a git repository', async () => {
    const dir = path.join(tmp, 'scratch-dir');
    await fs.mkdir(dir);

    expect(await projectName(dir)).toBe('scratch-dir');
  });
});

describe('capture hook entrypoint', () => {
  let server: http.Server;
  let url: string;
  let received: Array<Record<string, unknown>>;
  let tmp: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end('{"status":"accepted"}');
      });
    });
    url = `http://127.0.0.1:${await listen(server)}/webhook/knowledge-graph/trigger`;
  });

  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

  beforeEach(async () => {
    received = [];
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-hook-')));
  });

  test('every code capture carries the session id and the project', async () => {
    const repo = await makeRepo(tmp, 'project-a');
    await fs.mkdir(path.join(repo, 'src'));
    const files = [path.join(repo, 'greet.ts'), path.join(repo, 'src', 'util.ts')];
    const transcript = await writeTranscript(tmp, files);

    const code = await runHook(
      { session_id: 'sess-42', transcript_path: transcript, cwd: path.join(repo, 'src'), hook_event_name: 'Stop' },
      { SWARM_KG_URL: url },
    );

    expect(code).toBe(0);
    expect(received).toHaveLength(2);
    for (const capture of received) {
      expect(capture.session_id).toBe('sess-42');
      expect(capture.project).toBe('project-a');
    }
  });

  test('outside a git repository the project is the working directory name', async () => {
    const dir = path.join(tmp, 'loose-files');
    await fs.mkdir(dir);
    const transcript = await writeTranscript(tmp, [path.join(dir, 'a.py')]);

    await runHook({ session_id: 'sess-7', transcript_path: transcript, cwd: dir, hook_event_name: 'Stop' }, { SWARM_KG_URL: url });

    expect(received).toHaveLength(1);
    expect(received[0].project).toBe('loose-files');
    expect(received[0].session_id).toBe('sess-7');
  });

  test("edits in the session's scratchpad are not code captures, so /remember's memo file never becomes a note", async () => {
    const repo = await makeRepo(tmp, 'project-a');
    const scratchpad = path.join(tmp, 'scratchpad');
    await fs.mkdir(scratchpad);
    const transcript = await writeTranscript(tmp, [path.join(repo, 'greet.ts'), path.join(scratchpad, 'memos.json')]);

    await runHook(
      { session_id: 'sess-1', transcript_path: transcript, cwd: repo, scratchpad_dir: scratchpad, hook_event_name: 'Stop' },
      { SWARM_KG_URL: url },
    );

    expect(received.map(c => c.file_path)).toEqual(['greet.ts']);
  });

  test("only files inside the session's project become code captures, not Claude's own memory files elsewhere", async () => {
    const repo = await makeRepo(tmp, 'project-a');
    await fs.mkdir(path.join(repo, 'src'));
    const memory = path.join(tmp, 'home', '.claude', 'projects', '-project-a', 'memory', 'MEMORY.md');
    const transcript = await writeTranscript(tmp, [path.join(repo, 'greet.ts'), memory, path.join(tmp, 'sibling', 'x.ts')]);

    await runHook(
      { session_id: 'sess-1', transcript_path: transcript, cwd: path.join(repo, 'src'), hook_event_name: 'Stop' },
      { SWARM_KG_URL: url },
    );

    expect(received.map(c => c.file_path)).toEqual(['greet.ts']);
  });

  test("the project is Claude Code's project directory even after the shell cd's elsewhere", async () => {
    const repo = await makeRepo(tmp, 'project-a');
    const elsewhere = path.join(tmp, 'elsewhere');
    await fs.mkdir(elsewhere);
    const transcript = await writeTranscript(tmp, [path.join(repo, 'greet.ts'), path.join(elsewhere, 'out.txt')]);

    await runHook(
      { session_id: 'sess-1', transcript_path: transcript, cwd: elsewhere, hook_event_name: 'Stop' },
      { SWARM_KG_URL: url, CLAUDE_PROJECT_DIR: repo },
    );

    expect(received.map(c => [c.file_path, c.project])).toEqual([['greet.ts', 'project-a']]);
  });
}, 20_000);
