import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { createApp } from '../src/server';
import { Config } from '../src/config';

/**
 * Mock Ollama: inspects the system prompt to decide which canned response to
 * return, mimicking how each agent gets a different reply.
 */
function createMockOllama(state: { linkTargets: string[] }): http.Server {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      const system: string = parsed.messages?.[0]?.content ?? '';

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
          links_to_add: ['[[existing-note]]'],
        }));
        content = JSON.stringify(linkMap);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'mock', message: { role: 'assistant', content }, done: true }));
    });
  });
}

describe('POST /webhook/knowledge-graph/trigger (end-to-end)', () => {
  let mockServer: http.Server;
  let mockPort: number;
  let vaultDir: string;
  let cfg: Config;
  const mockState = { linkTargets: [] as string[] };

  beforeAll(async () => {
    mockServer = createMockOllama(mockState);
    await new Promise<void>(resolve => mockServer.listen(0, resolve));
    mockPort = (mockServer.address() as { port: number }).port;
  });

  afterAll(() => new Promise<void>(resolve => mockServer.close(() => resolve())));

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-e2e-'));
    mockState.linkTargets = [];
    cfg = {
      port: 0,
      vaultPath: vaultDir,
      ollamaUrl: `http://127.0.0.1:${mockPort}`,
      ollamaModel: 'mock-model',
    };
  });

  const PAYLOAD = {
    file_path: 'src/auth/jwt.py',
    language: 'python',
    description: 'JWT token refresh with sliding expiry',
    changed_code: 'def refresh(): pass',
  };

  test('happy path: returns 200 with complete status and note paths', async () => {
    const res = await request(createApp(cfg))
      .post('/webhook/knowledge-graph/trigger')
      .send(PAYLOAD);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('complete');
    expect(res.body.file_path).toBe('src/auth/jwt.py');
    expect(res.body.language).toBe('python');
    expect(res.body.notes).toHaveLength(2);
    expect(res.body.linker.status).toBe('success');
  });

  test('writes a code note with required frontmatter', async () => {
    await request(createApp(cfg)).post('/webhook/knowledge-graph/trigger').send(PAYLOAD);

    const codeFiles = await fs.readdir(path.join(vaultDir, 'code'));
    expect(codeFiles).toHaveLength(1);
    const content = await fs.readFile(path.join(vaultDir, 'code', codeFiles[0]), 'utf8');
    for (const key of ['title:', 'date:', 'tags:', 'related:', 'source:', 'type: "code"']) {
      expect(content).toContain(key);
    }
  });

  test('writes a research note to research/', async () => {
    await request(createApp(cfg)).post('/webhook/knowledge-graph/trigger').send(PAYLOAD);

    const files = await fs.readdir(path.join(vaultDir, 'research'));
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('_research_');
    const content = await fs.readFile(path.join(vaultDir, 'research', files[0]), 'utf8');
    expect(content).toContain('type: "research"');
  });

  test('writes a session log and appends on repeat triggers', async () => {
    const app = createApp(cfg);
    await request(app).post('/webhook/knowledge-graph/trigger').send(PAYLOAD);
    await request(app).post('/webhook/knowledge-graph/trigger').send(PAYLOAD);

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
    const first = await request(app).post('/webhook/knowledge-graph/trigger').send(PAYLOAD);
    const codeNote = first.body.notes.find((n: { agent: string }) => n.agent === 'documenter');

    // Fresh vault state per test, so re-trigger with the mock now configured
    // to suggest links for the note that will be (re)created at the same path.
    mockState.linkTargets = [codeNote.note_path];
    const second = await request(app).post('/webhook/knowledge-graph/trigger').send(PAYLOAD);

    expect(second.body.linker.links_written).toBe(1);
    const content = await fs.readFile(codeNote.note_path, 'utf8');
    expect(content).toContain('## Related Notes');
    expect(content).toContain('- [[existing-note]]');
  });

  test('linker never writes to paths outside the notes it created', async () => {
    const app = createApp(cfg);
    const evil = path.join(vaultDir, 'evil.md');
    mockState.linkTargets = [evil];

    const res = await request(app).post('/webhook/knowledge-graph/trigger').send(PAYLOAD);

    expect(res.body.linker.links_written).toBe(0);
    await expect(fs.access(evil)).rejects.toThrow();
  });

  test('empty payload returns 400 with a helpful error', async () => {
    const res = await request(createApp(cfg))
      .post('/webhook/knowledge-graph/trigger')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('file_path');
  });

  test('payload with only description is accepted', async () => {
    const res = await request(createApp(cfg))
      .post('/webhook/knowledge-graph/trigger')
      .send({ description: 'thinking about caching strategies' });

    expect(res.status).toBe(200);
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
      const res = await request(createApp({ ...cfg, ollamaUrl: `http://127.0.0.1:${flakyPort}` }))
        .post('/webhook/knowledge-graph/trigger')
        .send(PAYLOAD);

      expect(res.status).toBe(200);
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
