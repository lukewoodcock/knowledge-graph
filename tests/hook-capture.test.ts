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

/** Runs the hook with `input` on stdin and an env free of the developer's own KG_* settings. */
function runHook(input: object, env: Record<string, string>): Promise<number | null> {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('KG_') && k !== 'CLAUDE_PROJECT_DIR'));
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

/** A transcript whose last turn began at `startedAt` and made these tool calls. */
async function writeTurn(dir: string, startedAt: Date, calls: Array<[string, object]>): Promise<string> {
  const lines = [
    { type: 'user', timestamp: startedAt.toISOString(), message: { role: 'user', content: 'Add rate limiting' } },
    ...calls.map(([name, input], i) => ({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name, input }] },
    })),
  ];
  const p = path.join(dir, 'transcript.jsonl');
  await fs.writeFile(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

/** Writes and commits `files` (paths relative to the repo). */
async function commitFiles(repo: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
    await fs.writeFile(path.join(repo, rel), text);
  }
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'files');
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
      { KG_URL: url },
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

    await runHook({ session_id: 'sess-7', transcript_path: transcript, cwd: dir, hook_event_name: 'Stop' }, { KG_URL: url });

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
      { KG_URL: url },
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
      { KG_URL: url },
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
      { KG_URL: url, CLAUDE_PROJECT_DIR: repo },
    );

    expect(received.map(c => [c.file_path, c.project])).toEqual([['greet.ts', 'project-a']]);
  });

  describe('files changed by shell commands', () => {
    const since = () => new Date(Date.now() - 2000);
    const stop = (transcript: string, repo: string) =>
      runHook({ session_id: 'sess-1', transcript_path: transcript, cwd: repo, hook_event_name: 'Stop' }, { KG_URL: url });

    test('a file Claude changed with a shell command is a code capture with its git diff, next to the edit-tool files', async () => {
      const repo = await makeRepo(tmp, 'shortlinks');
      await commitFiles(repo, { 'src/server.js': 'const limit = 1;\n' });
      const rateLimit = path.join(repo, 'src', 'rate-limit.js');
      const transcript = await writeTurn(tmp, since(), [
        ['Write', { file_path: rateLimit, content: '// bucket' }],
        ['Bash', { command: "python3 - <<'EOF'\n# edits src/server.js\nEOF" }],
      ]);
      await fs.writeFile(rateLimit, '// bucket\n');
      await fs.writeFile(path.join(repo, 'src', 'server.js'), 'const limit = 5;\n');

      await stop(transcript, repo);

      expect(received.map(c => c.file_path)).toEqual(['src/rate-limit.js', 'src/server.js']);
      expect(received[1].changed_code).toContain('+const limit = 5;');
      expect(received[1].language).toBe('javascript');
    });

    test('a new file a shell command created is captured with its text, and git-ignored files are not', async () => {
      const repo = await makeRepo(tmp, 'shortlinks');
      await commitFiles(repo, { '.gitignore': 'data/\n' });
      const transcript = await writeTurn(tmp, since(), [['Bash', { command: 'node scripts/gen.js' }]]);
      await fs.mkdir(path.join(repo, 'src'));
      await fs.writeFile(path.join(repo, 'src', 'codes.js'), 'module.exports = 42;\n');
      await fs.mkdir(path.join(repo, 'data'));
      await fs.writeFile(path.join(repo, 'data', 'links.json'), '{}');

      await stop(transcript, repo);

      expect(received.map(c => c.file_path)).toEqual(['src/codes.js']);
      expect(received[0].changed_code).toContain('module.exports = 42;');
    });

    test('uncommitted changes from before the turn began are not captured again', async () => {
      const repo = await makeRepo(tmp, 'shortlinks');
      await commitFiles(repo, { 'src/server.js': 'const limit = 1;\n' });
      const old = path.join(repo, 'src', 'server.js');
      await fs.writeFile(old, 'const limit = 2;\n');
      const anHourAgo = new Date(Date.now() - 3_600_000);
      await fs.utimes(old, anHourAgo, anHourAgo);
      const transcript = await writeTurn(tmp, since(), [['Bash', { command: 'npm test' }]]);

      await stop(transcript, repo);

      expect(received).toEqual([]);
    });

    test("in a turn with no shell command, files changed elsewhere (in the user's editor) are not captured", async () => {
      const repo = await makeRepo(tmp, 'shortlinks');
      await commitFiles(repo, { 'src/server.js': 'const limit = 1;\n' });
      const greet = path.join(repo, 'greet.ts');
      const transcript = await writeTurn(tmp, since(), [['Write', { file_path: greet, content: 'hi' }]]);
      await fs.writeFile(greet, 'hi\n');
      await fs.writeFile(path.join(repo, 'src', 'server.js'), 'const limit = 9;\n');

      await stop(transcript, repo);

      expect(received.map(c => c.file_path)).toEqual(['greet.ts']);
    });
  });
}, 20_000);
