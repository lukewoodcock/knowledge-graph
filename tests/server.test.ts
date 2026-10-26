import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { Express } from 'express';
import { createApp } from '../src/server';
import { Config, loadConfig } from '../src/config';

/**
 * Mock Ollama: inspects the system prompt to decide which canned response to
 * return, mimicking how each agent gets a different reply.
 */
interface MockState {
  linkTargets: string[];
  links: string[];
  /** How long each reply takes, so runs that overlap would interleave. */
  delayMs: number;
  /** The user prompt of every chat request, in the order they arrived. */
  prompts: string[];
}

function createMockOllama(state: MockState): http.Server {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', async () => {
      const parsed = JSON.parse(body || '{}');
      const system: string = parsed.messages?.[0]?.content ?? '';
      state.prompts.push(parsed.messages?.[1]?.content ?? '');
      if (state.delayMs > 0) await new Promise(resolve => setTimeout(resolve, state.delayMs));

      let content: string;
      if (system.includes('documentation assistant')) {
        content = [
          '---',
          'title: "JWT Refresh Implementation"',
          'date: 2026-06-10',
          'tags: [python, jwt]',
          'related: []',
          'source: "ide-webhook"',
          'type: "code"',
          '---',
          '',
          '## Summary',
          'Implements JWT refresh.',
        ].join('\n');
      } else if (system.includes('research assistant')) {
        content = [
          '---',
          'title: "Research: JWT Refresh"',
          'date: 2026-06-10',
          'tags: [research, python, best-practices]',
          'related: []',
          'source: "ollama-research"',
          'type: "research"',
          '---',
          '',
          '## Overview',
          'JWTs are stateless tokens.',
        ].join('\n');
      } else {
        // Linker: suggest links for whichever note paths the test configured.
        const linkMap = state.linkTargets.map(p => ({
          new_note_path: p,
          links_to_add: state.links,
        }));
        content = JSON.stringify(linkMap);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'mock', message: { role: 'assistant', content }, done: true }));
    });
  });
}

// Under vitest's 5s test timeout, so a stuck run fails with its last status
// instead of a bare "timed out".
const RUN_DEADLINE_MS = 3000;

/** Polls a run's status URL until it finishes, failing after RUN_DEADLINE_MS. */
async function waitForRun(app: Express, statusUrl: string): Promise<request.Response> {
  const deadline = Date.now() + RUN_DEADLINE_MS;
  for (;;) {
    const run = await request(app).get(statusUrl);
    if (run.body.status !== 'running') return run;
    if (Date.now() > deadline) {
      throw new Error(`Run still running after ${RUN_DEADLINE_MS}ms: ${JSON.stringify(run.body)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** Triggers a run, checks it was accepted, then waits for it to finish. */
async function triggerAndWait(app: Express, payload: object): Promise<request.Response> {
  const accepted = await request(app).post('/webhook/knowledge-graph/trigger').send(payload);
  expect(accepted.status).toBe(202);
  return waitForRun(app, accepted.body.status_url);
}

describe('POST /webhook/knowledge-graph/trigger (end-to-end)', () => {
  let mockServer: http.Server;
  let mockPort: number;
  let vaultDir: string;
  let cfg: Config;
  const mockState: MockState = { linkTargets: [], links: [], delayMs: 0, prompts: [] };

  beforeAll(async () => {
    mockServer = createMockOllama(mockState);
    await new Promise<void>(resolve => mockServer.listen(0, resolve));
    mockPort = (mockServer.address() as { port: number }).port;
  });

  afterAll(() => new Promise<void>(resolve => mockServer.close(() => resolve())));

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-e2e-'));
    mockState.linkTargets = [];
    mockState.links = ['[[existing-note]]'];
    mockState.delayMs = 0;
    mockState.prompts = [];
    cfg = {
      port: 0,
      vaultPath: vaultDir,
      ollamaUrl: `http://127.0.0.1:${mockPort}`,
      ollamaModel: 'mock-model',
      ollamaThink: false,
      researcher: false,
    };
  });

  const PAYLOAD = {
    file_path: 'src/auth/jwt.py',
    language: 'python',
    description: 'JWT token refresh with sliding expiry',
    changed_code: 'def refresh(): pass',
  };

  test('responds 202 with a run id before the agents finish', async () => {
    const app = createApp(cfg);
    const res = await request(app).post('/webhook/knowledge-graph/trigger').send(PAYLOAD);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('accepted');
    expect(res.body.status_url).toBe(`/webhook/knowledge-graph/runs/${res.body.run_id}`);

    // Let the run finish so it can't touch the shared mock during later tests.
    await waitForRun(app, res.body.status_url);
  });

  test('unknown run id returns 404', async () => {
    const res = await request(createApp(cfg)).get('/webhook/knowledge-graph/runs/nope');
    expect(res.status).toBe(404);
  });

  test('happy path: run finishes with complete status and note paths', async () => {
    const res = await triggerAndWait(createApp(cfg), PAYLOAD);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('complete');
    expect(res.body.file_path).toBe('src/auth/jwt.py');
    expect(res.body.language).toBe('python');
    expect(res.body.linker.status).toBe('success');
  });

  test('with the Researcher off (the default), a code capture writes only the Documenter note', async () => {
    const res = await triggerAndWait(createApp(cfg), PAYLOAD);

    expect(res.body.status).toBe('complete');
    expect(res.body.notes).toHaveLength(1);
    expect(res.body.notes[0].agent).toBe('documenter');
    await expect(fs.readdir(path.join(vaultDir, 'research'))).rejects.toThrow();
  });

  test('the Researcher is off unless its setting is on', () => {
    expect(loadConfig({}).researcher).toBe(false);
    expect(loadConfig({ RESEARCHER_ENABLED: 'true' }).researcher).toBe(true);
  });

  test('with the Researcher on, a code capture writes a code note and a research note', async () => {
    const res = await triggerAndWait(createApp({ ...cfg, researcher: true }), PAYLOAD);

    expect(res.body.status).toBe('complete');
    expect(res.body.notes.map((n: { agent: string }) => n.agent).sort()).toEqual([
      'documenter',
      'researcher',
    ]);
  });

  test('writes a code note with required frontmatter', async () => {
    await triggerAndWait(createApp(cfg), PAYLOAD);

    const codeFiles = await fs.readdir(path.join(vaultDir, 'code'));
    expect(codeFiles).toHaveLength(1);
    const content = await fs.readFile(path.join(vaultDir, 'code', codeFiles[0]), 'utf8');
    for (const key of ['title:', 'date:', 'tags:', 'related:', 'source:', 'type: "code"']) {
      expect(content).toContain(key);
    }
  });

  test('with the Researcher on, writes a research note to research/', async () => {
    await triggerAndWait(createApp({ ...cfg, researcher: true }), PAYLOAD);

    const files = await fs.readdir(path.join(vaultDir, 'research'));
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('_research_');
    const content = await fs.readFile(path.join(vaultDir, 'research', files[0]), 'utf8');
    expect(content).toContain('type: "research"');
  });

  test('writes a session log and appends on repeat triggers', async () => {
    const app = createApp(cfg);
    await triggerAndWait(app, PAYLOAD);
    await triggerAndWait(app, PAYLOAD);

    const logFiles = await fs.readdir(path.join(vaultDir, 'logs'));
    expect(logFiles).toHaveLength(1);
    const content = await fs.readFile(path.join(vaultDir, 'logs', logFiles[0]), 'utf8');
    expect(content).toContain('type: "log"');
    // Two trigger entries, one frontmatter header.
    expect((content.match(/## \d{4}-/g) || []).length).toBe(2);
    expect((content.match(/^---$/gm) || []).length).toBe(2);
  });

  test('linker appends wikilinks to the new code note', async () => {
    const app = createApp(cfg);

    // First pass creates the notes; capture the code note path for the mock.
    const first = await triggerAndWait(app, PAYLOAD);
    const codeNote = first.body.notes.find((n: { agent: string }) => n.agent === 'documenter');

    // Fresh vault state per test, so re-trigger with the mock now configured
    // to suggest links for the note that will be (re)created at the same path.
    mockState.linkTargets = [codeNote.note_path];
    const second = await triggerAndWait(app, PAYLOAD);

    expect(second.body.linker.links_written).toBe(1);
    const content = await fs.readFile(codeNote.note_path, 'utf8');
    expect(content).toContain('## Related Notes');
    expect(content).toContain('- [[existing-note]]');
  });

  test('linker drops links to the note itself and to the session log', async () => {
    const app = createApp(cfg);
    const first = await triggerAndWait(app, PAYLOAD);
    const codeNote = first.body.notes.find((n: { agent: string }) => n.agent === 'documenter');
    const self = path.basename(codeNote.note_path, '.md');
    const log = (await fs.readdir(path.join(vaultDir, 'logs')))[0].replace(/\.md$/, '');

    mockState.linkTargets = [codeNote.note_path];
    mockState.links = [`[[${self}]]`, `[[${log}]]`, '[[existing-note]]'];
    await triggerAndWait(app, PAYLOAD);

    const content = await fs.readFile(codeNote.note_path, 'utf8');
    expect(content).toContain('- [[existing-note]]');
    expect(content).not.toContain(`[[${self}]]`);
    expect(content).not.toContain(`[[${log}]]`);
  });

  test('linker never writes to paths outside the notes it created', async () => {
    const app = createApp(cfg);
    const evil = path.join(vaultDir, 'evil.md');
    mockState.linkTargets = [evil];

    const res = await triggerAndWait(app, PAYLOAD);

    expect(res.body.linker.links_written).toBe(0);
    await expect(fs.access(evil)).rejects.toThrow();
  });

  test('captures sent while a run is in progress run one at a time, in arrival order', async () => {
    const app = createApp({ ...cfg, researcher: true });
    mockState.delayMs = 30;
    const captures = ['first', 'second', 'third'].map(name => ({
      ...PAYLOAD,
      file_path: `src/${name}.py`,
      description: `capture-${name}`,
    }));

    const accepted = [];
    for (const capture of captures) {
      const res = await request(app).post('/webhook/knowledge-graph/trigger').send(capture);
      expect(res.status).toBe(202);
      accepted.push(res.body);
    }
    const finished = await Promise.all(accepted.map(a => waitForRun(app, a.status_url)));

    expect(finished.map(r => r.body.status)).toEqual(['complete', 'complete', 'complete']);
    // Every Ollama call names its capture's description; one at a time means
    // each capture's calls form one unbroken block, in the order they were sent.
    const owners = mockState.prompts.map(p => /(?:Description|Context): (capture-\w+)/.exec(p)![1]);
    const blocks = owners.filter((o, i) => i === 0 || owners[i - 1] !== o);
    expect(blocks).toEqual(['capture-first', 'capture-second', 'capture-third']);
  });

  test('a capture queued behind a failing run still runs', async () => {
    const app = createApp({ ...cfg, ollamaUrl: 'http://127.0.0.1:1' });
    const first = await request(app).post('/webhook/knowledge-graph/trigger').send(PAYLOAD);
    const second = await request(app).post('/webhook/knowledge-graph/trigger').send(PAYLOAD);

    const runs = await Promise.all([first, second].map(a => waitForRun(app, a.body.status_url)));
    expect(runs.map(r => r.body.status)).toEqual(['partial', 'partial']);
  });

  test('the console logs one line per finished run with its id, status and duration', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const app = createApp(cfg);
      const accepted = await request(app).post('/webhook/knowledge-graph/trigger').send(PAYLOAD);
      await waitForRun(app, accepted.body.status_url);

      const lines = log.mock.calls.map(c => c.join(' ')).filter(l => l.includes(accepted.body.run_id));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(new RegExp(`${accepted.body.run_id} complete in \\d+\\.\\ds`));
    } finally {
      log.mockRestore();
    }
  });

  test('empty payload returns 400 with a helpful error', async () => {
    const res = await request(createApp(cfg))
      .post('/webhook/knowledge-graph/trigger')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('file_path');
  });

  test('payload with only description is accepted', async () => {
    const res = await triggerAndWait(createApp(cfg), {
      description: 'thinking about caching strategies',
    });

    expect(res.body.status).toBe('complete');
  });

  test('returns partial status when one agent fails', async () => {
    // Point at a dead Ollama for this app, then bring up a half-broken mock:
    // simplest reliable failure — use an unreachable port so both fail,
    // then assert the response degrades rather than 500s... but we want ONE
    // failure. Instead: make the mock return 500 only for the researcher.
    const flaky = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        const system: string = JSON.parse(body).messages?.[0]?.content ?? '';
        if (system.includes('research assistant')) {
          res.writeHead(500);
          res.end('boom');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            message: { role: 'assistant', content: system.includes('linking') ? '[]' : '# note' },
          }),
        );
      });
    });
    await new Promise<void>(resolve => flaky.listen(0, resolve));
    const flakyPort = (flaky.address() as { port: number }).port;

    try {
      const res = await triggerAndWait(
        createApp({ ...cfg, researcher: true, ollamaUrl: `http://127.0.0.1:${flakyPort}` }),
        PAYLOAD,
      );

      expect(res.body.status).toBe('partial');
      expect(res.body.notes).toHaveLength(1);
      expect(res.body.notes[0].agent).toBe('documenter');
      expect(res.body.errors).toHaveLength(1);
    } finally {
      await new Promise<void>(resolve => flaky.close(() => resolve()));
    }
  });

  test('healthz responds ok', async () => {
    const res = await request(createApp(cfg)).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
