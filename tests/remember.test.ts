import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { startServer } from '../src/server';
import { Config } from '../src/config';
import { parseNote } from '../src/vault';
import { remember } from '../src/remember';
import { close, createMockOllama, createMockOllamaState, listen, resetMockOllamaState } from './helpers/mock-ollama';

const ROOT = path.resolve(__dirname, '..');

/** The command /remember runs: memos on stdin go to the real service, and it reports what was saved. */
describe('remember command', () => {
  let mockServer: http.Server;
  let mockPort: number;
  let vaultDir: string;
  let projectDir: string;
  let service: http.Server | undefined;
  const mockState = createMockOllamaState();

  beforeAll(async () => {
    mockServer = createMockOllama(mockState);
    mockPort = await listen(mockServer);
  });

  afterAll(() => {
    mockServer.closeAllConnections();
    return close(mockServer);
  });

  beforeEach(async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-remember-'));
    vaultDir = path.join(tmp, 'vault');
    projectDir = path.join(tmp, 'demo-project');
    await fs.mkdir(vaultDir);
    await fs.mkdir(projectDir);
    resetMockOllamaState(mockState);
    mockState.links = [];
  });

  afterEach(async () => {
    if (service) {
      service.closeAllConnections();
      await close(service);
      service = undefined;
    }
  });

  /** Starts the real service on a free port and returns its base URL. */
  async function startService(ollamaUrl = `http://127.0.0.1:${mockPort}`): Promise<string> {
    const cfg: Config = {
      host: '127.0.0.1',
      port: 0,
      vaultPath: vaultDir,
      ollamaUrl,
      ollamaModel: 'mock-model',
      ollamaThink: false,
      embedModel: 'mock-embed',
      researcher: false,
      noteMaxChars: 20_000,
    };
    service = await startServer(cfg);
    return `http://127.0.0.1:${(service.address() as { port: number }).port}`;
  }

  /** Runs the command and collects what it printed. */
  async function run(argv: string[], stdin: string, serviceUrl: string, env: NodeJS.ProcessEnv = {}) {
    const lines: string[] = [];
    const code = await remember(argv, stdin, { SWARM_KG_SERVICE_URL: serviceUrl, ...env }, l => lines.push(l), {
      pollMs: 5,
    });
    return { code, output: lines.join('\n') };
  }

  async function memoNotes() {
    const dir = path.join(vaultDir, 'memos');
    const files = (await fs.readdir(dir)).sort();
    return Promise.all(files.map(async f => parseNote(await fs.readFile(path.join(dir, f), 'utf8'))));
  }

  const DECISION = { kind: 'decision', title: 'Use write-through caching', body: 'We chose write-through caching.' };
  const TODO = { kind: 'todo', title: 'Add cache metrics', body: 'Count cache hits.' };

  test('saves each memo under the session and the project, and reports every memo with its name', async () => {
    execFileSync('git', ['init', '-q'], { cwd: projectDir });
    const url = await startService();

    const { code, output } = await run(
      ['--session', 'sess-1', '--project-dir', projectDir],
      JSON.stringify([DECISION, TODO]),
      url,
    );

    expect(code).toBe(0);
    const notes = await memoNotes();
    expect(notes.map(n => n.frontmatter)).toEqual([
      expect.objectContaining({ title: 'Add cache metrics', kind: 'todo', project: 'demo-project', session: 'sess-1' }),
      expect.objectContaining({ title: 'Use write-through caching', kind: 'decision', project: 'demo-project', session: 'sess-1' }),
    ]);
    expect(output).toContain('Use_write-through_caching (decision)');
    expect(output).toContain('Add_cache_metrics (todo)');
  });

  test("reports the links of each memo, including the session's code captures", async () => {
    const url = await startService();
    const capture = await fetch(`${url}/webhook/knowledge-graph/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_path: 'src/cache.ts', description: 'cache', session_id: 'sess-1', project: 'demo-project' }),
    });
    expect(capture.status).toBe(202);

    // The memo run queues behind the code capture, so its note exists by then.
    const { code, output } = await run(['--session', 'sess-1', '--project-dir', projectDir], JSON.stringify(DECISION), url);

    expect(code).toBe(0);
    expect(output).toMatch(/Use_write-through_caching \(decision\)\n\s+links: \[\[\d{4}-\d{2}-\d{2}_demo-project_src_cache\.ts\]\]/);
  });

  test('says a memo has no links when it has none', async () => {
    const url = await startService();

    const { output } = await run(['--session', 'sess-1', '--project-dir', projectDir], JSON.stringify(DECISION), url);

    expect(output).toMatch(/Use_write-through_caching \(decision\)\n\s+links: none/);
  });

  test("an invalid memo fails with the service's reason, so the agent can fix it and resend", async () => {
    const url = await startService();

    const { code, output } = await run(
      ['--session', 'sess-1', '--project-dir', projectDir],
      JSON.stringify([DECISION, { ...TODO, kind: 'idea' }]),
      url,
    );

    expect(code).toBe(1);
    expect(output).toContain('memos[1].kind must be one of');
    await expect(fs.readdir(path.join(vaultDir, 'memos'))).rejects.toThrow();
  });

  test('fails clearly when the service is down', async () => {
    const { code, output } = await run(
      ['--session', 'sess-1', '--project-dir', projectDir],
      JSON.stringify(DECISION),
      'http://127.0.0.1:9',
    );

    expect(code).toBe(1);
    expect(output).toContain('The swarm-kg service is not reachable at http://127.0.0.1:9');
  });

  test('fails clearly when stdin is not JSON, before sending anything', async () => {
    const url = await startService();

    const { code, output } = await run(['--session', 'sess-1', '--project-dir', projectDir], '{"kind": "todo",', url);

    expect(code).toBe(1);
    expect(output).toContain('stdin is not valid JSON');
    await expect(fs.readdir(path.join(vaultDir, 'memos'))).rejects.toThrow();
  });

  test.each([
    ['missing', ['--project-dir']],
    ['blank', ['--session', '', '--project-dir']],
    ['left unsubstituted', ['--session', '${CLAUDE_SESSION_ID}', '--project-dir']],
  ])('refuses to send memos when the session id is %s', async (_case, args) => {
    const url = await startService();

    const { code, output } = await run([...args, projectDir], JSON.stringify(DECISION), url);

    expect(code).toBe(1);
    expect(output).toContain('--session');
    await expect(fs.readdir(path.join(vaultDir, 'memos'))).rejects.toThrow();
  });

  test('names the project after the git repository, even from a subfolder', async () => {
    execFileSync('git', ['init', '-q'], { cwd: projectDir });
    const sub = path.join(projectDir, 'src');
    await fs.mkdir(sub);
    const url = await startService();

    const { output } = await run(['--session', 'sess-1', '--project-dir', sub], JSON.stringify(DECISION), url);

    expect((await memoNotes())[0].frontmatter.project).toBe('demo-project');
    expect(output).toContain('demo-project');
  });

  test('with Ollama down the memos are still saved, and the report says the run was partial and why', async () => {
    const url = await startService('http://127.0.0.1:9');

    const { code, output } = await run(['--session', 'sess-1', '--project-dir', projectDir], JSON.stringify(DECISION), url);

    expect(code).toBe(0);
    expect(output).toContain('Use_write-through_caching (decision)');
    expect(output).toMatch(/partial.*linker/s);
  });

  test('a run that saved nothing fails with its error', async () => {
    // A file where the memos folder should be: the memo can't be written.
    await fs.writeFile(path.join(vaultDir, 'memos'), '', 'utf8');
    const url = await startService();

    const { code, output } = await run(['--session', 'sess-1', '--project-dir', projectDir], JSON.stringify(DECISION), url);

    expect(code).toBe(1);
    expect(output).toMatch(/failed.*Nothing was saved/s);
  });

  test('a run still going after the wait is reported as queued, with the command that picks it up later', async () => {
    // A note to link to, so the run asks the (slow) Linker.
    await fs.mkdir(path.join(vaultDir, 'code'));
    await fs.writeFile(path.join(vaultDir, 'code', 'cache-notes.md'), '## Summary\ncache', 'utf8');
    mockState.delayMs = 200;
    const url = await startService();
    const argv = ['--session', 'sess-1', '--project-dir', projectDir];

    const first = await run(argv, JSON.stringify(DECISION), url, { SWARM_KG_REMEMBER_WAIT_MS: '20' });

    expect(first.code).toBe(2);
    expect(first.output).toContain('still running');
    const runId = first.output.match(/--run (\S+)/)?.[1];
    expect(runId).toBeDefined();

    const later = await run(['--run', runId!], '', url);

    expect(later.code).toBe(0);
    expect(later.output).toContain('Use_write-through_caching (decision)');
  });

  test('runs as `node dist/remember.js` with the memos on stdin, reading the service from SWARM_KG_SERVICE_URL', async () => {
    const url = await startService();
    // tsx runs the entrypoint as node would run the built file, without a build.
    const child = spawn(
      process.execPath,
      [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(ROOT, 'src', 'remember.ts'),
        '--session', 'sess-1', '--project-dir', projectDir],
      { env: { ...process.env, SWARM_KG_SERVICE_URL: url } },
    );
    let stdout = '';
    child.stdout.on('data', c => (stdout += c));
    child.stdin.end(JSON.stringify({ memos: [DECISION] }));
    const code = await new Promise(resolve => child.on('close', resolve));

    expect(code).toBe(0);
    expect(stdout).toContain('Use_write-through_caching (decision)');
  }, 15_000);
});
