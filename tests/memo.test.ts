import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { Express } from 'express';
import { createApp } from '../src/server';
import { Config } from '../src/config';
import { parseNote, today } from '../src/vault';
import {
  close,
  createMockOllama,
  createMockOllamaState,
  embeddedTexts,
  listen,
  resetMockOllamaState,
} from './helpers/mock-ollama';
import { triggerAndWait, waitForRun } from './helpers/runs';

const MEMO_URL = '/webhook/knowledge-graph/memo';

describe('POST /webhook/knowledge-graph/memo (end-to-end)', () => {
  let mockServer: http.Server;
  let mockPort: number;
  let vaultDir: string;
  let cfg: Config;
  const mockState = createMockOllamaState();

  beforeAll(async () => {
    mockServer = createMockOllama(mockState);
    mockPort = await listen(mockServer);
  });

  afterAll(() => close(mockServer));

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-memo-'));
    resetMockOllamaState(mockState);
    // No similarity links unless a test asks for them.
    mockState.links = [];
    cfg = {
      host: '127.0.0.1',
      port: 0,
      vaultPath: vaultDir,
      ollamaUrl: `http://127.0.0.1:${mockPort}`,
      ollamaModel: 'mock-model',
      ollamaThink: false,
      embedModel: 'mock-embed',
      researcher: false,
    };
  });

  const MEMO = {
    kind: 'decision',
    title: 'Use write-through caching',
    body: 'In project-a we chose write-through caching for the session cache.',
    project: 'project-a',
    session_id: 'sess-1',
  };

  /** Sends memos, checks they were accepted, then waits for the run to finish. */
  async function memoAndWait(app: Express, payload: unknown): Promise<request.Response> {
    const accepted = await request(app).post(MEMO_URL).send(payload as object);
    expect(accepted.status).toBe(202);
    return waitForRun(app, accepted.body.status_url);
  }

  async function readNote(notePath: string) {
    return parseNote(await fs.readFile(notePath, 'utf8'));
  }

  test('a memo is accepted with 202 and a run id, and written to the memos folder', async () => {
    const app = createApp(cfg);
    const accepted = await request(app).post(MEMO_URL).send(MEMO);

    expect(accepted.status).toBe(202);
    expect(accepted.body.status).toBe('accepted');
    expect(accepted.body.status_url).toBe(`/webhook/knowledge-graph/runs/${accepted.body.run_id}`);

    const run = await waitForRun(app, accepted.body.status_url);
    expect(run.body.status).toBe('complete');
    expect(run.body.memos).toHaveLength(1);
    const memo = run.body.memos[0];
    expect(path.dirname(memo.note_path)).toBe(path.join(vaultDir, 'memos'));
    expect(memo.name).toBe(path.basename(memo.note_path, '.md'));

    const note = await readNote(memo.note_path);
    expect(note.frontmatter).toMatchObject({
      title: 'Use write-through caching',
      kind: 'decision',
      project: 'project-a',
      session: 'sess-1',
    });
    expect(note.body).toContain('In project-a we chose write-through caching for the session cache.');
  });

  test('a list of memos is written as one note each, all listed in the run', async () => {
    const todo = { ...MEMO, kind: 'todo', title: 'Add cache metrics', body: 'Count cache hits in project-a.' };

    const run = await memoAndWait(createApp(cfg), { memos: [MEMO, todo] });

    expect(run.body.status).toBe('complete');
    expect(run.body.memos.map((m: { kind: string }) => m.kind)).toEqual(['decision', 'todo']);
    const titles = await Promise.all(
      run.body.memos.map(async (m: { note_path: string }) => (await readNote(m.note_path)).frontmatter.title),
    );
    expect(titles).toEqual(['Use write-through caching', 'Add cache metrics']);
  });

  test('a bare JSON array of memos is accepted too', async () => {
    const run = await memoAndWait(createApp(cfg), [MEMO, { ...MEMO, title: 'Second' }]);
    expect(run.body.memos).toHaveLength(2);
  });

  test.each([
    ['an unknown kind', { ...MEMO, kind: 'idea' }, 'kind'],
    ['a missing title', { ...MEMO, title: undefined }, 'title'],
    ['a blank body', { ...MEMO, body: '   ' }, 'body'],
    ['a missing project', { ...MEMO, project: undefined }, 'project'],
    ['a missing session id', { ...MEMO, session_id: undefined }, 'session_id'],
    ['files that are not a list of paths', { ...MEMO, files: 'src/a.ts' }, 'files'],
  ])('a memo with %s is rejected with 400 naming the field, and nothing is written', async (_case, memo, field) => {
    const res = await request(createApp(cfg)).post(MEMO_URL).send({ memos: [MEMO, memo] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain(`memos[1].${field}`);
    await expect(fs.readdir(path.join(vaultDir, 'memos'))).rejects.toThrow();
  });

  test('an empty list of memos is rejected with 400', async () => {
    const res = await request(createApp(cfg)).post(MEMO_URL).send({ memos: [] });
    expect(res.status).toBe(400);
  });

  test('every kind is accepted', async () => {
    const kinds = ['learning', 'decision', 'todo', 'snippet', 'conversation'];
    const run = await memoAndWait(
      createApp(cfg),
      kinds.map(kind => ({ ...MEMO, kind, title: `A ${kind}` })),
    );
    expect(run.body.memos.map((m: { kind: string }) => m.kind)).toEqual(kinds);
  });

  test('a todo memo is open; other kinds have no status', async () => {
    const run = await memoAndWait(createApp(cfg), [
      { ...MEMO, kind: 'todo', title: 'Add cache metrics' },
      { ...MEMO, kind: 'learning', title: 'Caches need TTLs' },
    ]);

    const [todo, learning] = await Promise.all(
      run.body.memos.map((m: { note_path: string }) => readNote(m.note_path)),
    );
    expect(todo.frontmatter.status).toBe('open');
    expect(learning.frontmatter).not.toHaveProperty('status');
  });

  test("a memo's files are recorded in its frontmatter", async () => {
    const run = await memoAndWait(createApp(cfg), { ...MEMO, files: ['src/cache.ts', 'docs/adr/0002-cache.md'] });

    const content = await fs.readFile(run.body.memos[0].note_path, 'utf8');
    expect(parseNote(content).frontmatter.files).toBe('["src/cache.ts", "docs/adr/0002-cache.md"]');
  });

  /** Runs a code capture and returns the name of the code note it wrote. */
  async function codeCapture(app: Express, filePath: string, session: string): Promise<string> {
    const run = await triggerAndWait(app, {
      file_path: filePath,
      language: 'typescript',
      description: `Work on ${filePath}`,
      session_id: session,
      project: 'project-a',
    });
    const code = run.body.notes.find((n: { agent: string }) => n.agent === 'documenter');
    return path.basename(code.note_path, '.md');
  }

  test('a memo links to every code-capture note from its session, and none from other sessions', async () => {
    const app = createApp(cfg);
    const cache = await codeCapture(app, 'src/cache.ts', 'sess-1');
    const metrics = await codeCapture(app, 'src/metrics.ts', 'sess-1');
    const other = await codeCapture(app, 'src/other.ts', 'sess-2');

    const run = await memoAndWait(app, MEMO);

    const memo = run.body.memos[0];
    expect(memo.links).toEqual(expect.arrayContaining([cache, metrics]));
    expect(memo.links).not.toContain(other);
    const content = await fs.readFile(memo.note_path, 'utf8');
    expect(content).toContain(`[[${cache}]]`);
    expect(content).toContain(`[[${metrics}]]`);
    expect(content).not.toContain(`[[${other}]]`);
  });

  test('memos do not link to other memos through the session rule', async () => {
    const app = createApp(cfg);
    const first = await memoAndWait(app, MEMO);

    const second = await memoAndWait(app, { ...MEMO, title: 'Another decision' });

    expect(second.body.memos[0].links).not.toContain(first.body.memos[0].name);
  });

  test('a memo from a session with no code captures has no session links', async () => {
    const app = createApp(cfg);
    await codeCapture(app, 'src/other.ts', 'sess-2');

    const run = await memoAndWait(app, MEMO);

    expect(run.body.memos[0].links).toEqual([]);
  });

  /** Where the memo run writes a memo with this title today. */
  function memoPath(title: string): string {
    return path.join(vaultDir, 'memos', `${today()}_${title.replace(/[^a-zA-Z0-9_\-.]/g, '_')}.md`);
  }

  test('the Linker adds similarity links on top of the session links, each reported once', async () => {
    const app = createApp(cfg);
    const cache = await codeCapture(app, 'src/cache.ts', 'sess-1');
    await fs.writeFile(path.join(vaultDir, 'code', 'existing-note.md'), '# Existing\n', 'utf8');
    mockState.linkTargets = [memoPath(MEMO.title)];
    // The Linker also suggests a note the session rule already links.
    mockState.links = ['[[existing-note]]', `[[${cache}]]`];

    const run = await memoAndWait(app, MEMO);

    expect(run.body.linker).toEqual({ status: 'success', links_written: 1 });
    const memo = run.body.memos[0];
    expect(memo.links).toEqual([cache, 'existing-note']);
    const content = await fs.readFile(memo.note_path, 'utf8');
    expect(content).toMatch(/## Related Notes\n- \[\[existing-note\]\]/);
    expect(content).toContain(`## Same Session\n- [[${cache}]]`);
  });

  test("the Linker is told about the memo, its kind and title", async () => {
    await memoAndWait(createApp(cfg), MEMO);

    const linkerPrompt = mockState.prompts.find(p => p.includes('New notes just added'));
    expect(linkerPrompt).toContain(memoPath(MEMO.title));
    expect(linkerPrompt).toContain('Use write-through caching');
    expect(linkerPrompt).toContain('decision');
  });

  test('a memo run skips the Documenter and Researcher', async () => {
    await memoAndWait(createApp({ ...cfg, researcher: true }), MEMO);

    expect(mockState.prompts.every(p => p.includes('New notes just added'))).toBe(true);
    await expect(fs.readdir(path.join(vaultDir, 'code'))).rejects.toThrow();
    await expect(fs.readdir(path.join(vaultDir, 'research'))).rejects.toThrow();
  });

  test('with Ollama down the memos are still written, and the run is partial', async () => {
    const run = await memoAndWait(createApp({ ...cfg, ollamaUrl: 'http://127.0.0.1:1' }), MEMO);

    expect(run.body.status).toBe('partial');
    expect(run.body.errors.join(' ')).toContain('linker');
    expect((await readNote(run.body.memos[0].note_path)).frontmatter.kind).toBe('decision');
  });

  function search(app: Express, body: object): Promise<request.Response> {
    return request(app).post('/webhook/knowledge-graph/search').send(body);
  }

  test('memos are in the index, with their kind and project, as soon as the run finishes', async () => {
    const app = createApp(cfg);
    const run = await memoAndWait(app, { ...MEMO, body: 'We chose a write-through cache.' });

    const res = await search(app, { query: 'cache' });

    expect(res.body.results[0]).toMatchObject({
      name: run.body.memos[0].name,
      kind: 'decision',
      project: 'project-a',
    });
  });

  test("session links don't count towards what a memo matches", async () => {
    const app = createApp(cfg);
    await codeCapture(app, 'src/docker_docker_docker.ts', 'sess-1');
    await memoAndWait(app, { ...MEMO, body: 'Nothing about containers here.' });

    const docker = embeddedTexts(mockState).filter(t => t.includes('Nothing about containers'));
    expect(docker.length).toBeGreaterThan(0);
    expect(docker.join('\n')).not.toContain('docker');
  });

  test('search filtered by kind returns only notes of that kind, so open todos can be recalled', async () => {
    const app = createApp(cfg);
    await codeCapture(app, 'src/cache.ts', 'sess-1');
    const run = await memoAndWait(app, [
      { ...MEMO, kind: 'todo', title: 'Add cache metrics', body: 'Count cache hits.' },
      { ...MEMO, kind: 'decision', title: 'Cache writes', body: 'Cache cache cache.' },
      { ...MEMO, kind: 'todo', title: 'Tune postgres', body: 'Postgres pool size.' },
    ]);
    const [metrics, , tune] = run.body.memos.map((m: { name: string }) => m.name);

    const res = await search(app, { query: 'cache', kind: 'todo', limit: 10 });

    expect(res.status).toBe(200);
    expect(res.body.results.map((r: { name: string }) => r.name)).toEqual([metrics, tune]);
    expect(res.body.results.every((r: { kind: string }) => r.kind === 'todo')).toBe(true);
  });

  test('search without a kind still returns every kind', async () => {
    const app = createApp(cfg);
    await codeCapture(app, 'src/cache.ts', 'sess-1');
    await memoAndWait(app, { ...MEMO, kind: 'todo', title: 'Add cache metrics', body: 'Count cache hits.' });

    const res = await search(app, { query: 'cache', limit: 10 });

    expect(new Set(res.body.results.map((r: { kind: string }) => r.kind))).toEqual(new Set(['todo', 'code']));
  });

  test('a kind filter that is not a string is rejected with 400', async () => {
    const res = await search(createApp(cfg), { query: 'cache', kind: 3 });
    expect(res.status).toBe(400);
  });

  test('a memo sent while a code capture is running waits its turn in the same queue', async () => {
    const app = createApp(cfg);
    mockState.delayMs = 30;
    const code = await request(app)
      .post('/webhook/knowledge-graph/trigger')
      .send({ file_path: 'src/cache.ts', description: 'capture-code', session_id: 'sess-1', project: 'project-a' });
    const memo = await request(app).post(MEMO_URL).send(MEMO);

    const [, memoRun] = await Promise.all([code, memo].map(r => waitForRun(app, r.body.status_url)));

    // The memo's Linker call comes only after every call of the code capture,
    // so the memo already sees, and links to, the code note.
    const owners = mockState.prompts.map(p => (p.includes('capture-code') ? 'code' : 'memo'));
    expect(owners).toEqual(['code', 'code', 'memo']);
    expect(memoRun.body.memos[0].links).toHaveLength(1);
  });

  test("memos are recorded in the day's session log", async () => {
    const run = await memoAndWait(createApp(cfg), [MEMO, { ...MEMO, kind: 'todo', title: 'Add cache metrics' }]);

    const log = await fs.readFile(path.join(vaultDir, 'logs', `${run.body.session_date}_session_log.md`), 'utf8');
    expect(log).toContain('- **Memo:** decision: Use write-through caching');
    expect(log).toContain('- **Memo:** todo: Add cache metrics');
  });

  test('two memos with the same title get separate notes', async () => {
    const run = await memoAndWait(createApp(cfg), [MEMO, { ...MEMO, body: 'Another take.' }]);

    const [a, b] = run.body.memos;
    expect(a.note_path).not.toBe(b.note_path);
    expect((await readNote(b.note_path)).body).toContain('Another take.');
  });
});
