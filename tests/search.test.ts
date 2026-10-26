import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { Express } from 'express';
import { createApp } from '../src/server';
import { Config } from '../src/config';
import {
  close,
  createMockOllama,
  createMockOllamaState,
  embeddedTexts,
  listen,
  resetMockOllamaState,
} from './helpers/mock-ollama';
import { triggerAndWait } from './helpers/runs';

const SEARCH_URL = '/webhook/knowledge-graph/search';

function search(app: Express, body: object): Promise<request.Response> {
  return request(app).post(SEARCH_URL).send(body);
}

describe('search over the embedding index (end-to-end)', () => {
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
    vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-search-'));
    resetMockOllamaState(mockState);
    cfg = {
      port: 0,
      vaultPath: vaultDir,
      ollamaUrl: `http://127.0.0.1:${mockPort}`,
      ollamaModel: 'mock-model',
      ollamaThink: false,
      embedModel: 'mock-embed',
    };
  });

  /** Writes a note into the vault the way a person editing it by hand would. */
  async function writeVaultNote(relPath: string, content: string): Promise<void> {
    const full = path.join(vaultDir, relPath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }

  const PAYLOAD = {
    file_path: 'src/auth/jwt.py',
    language: 'python',
    description: 'JWT token refresh with sliding expiry',
    changed_code: 'def refresh(): pass',
    session_id: 'sess-1',
    project: 'project-a',
  };

  test('a note written by a run is found by search as soon as the run finishes', async () => {
    const app = createApp(cfg);
    const run = await triggerAndWait(app, PAYLOAD);
    const codeNote = run.body.notes.find((n: { agent: string }) => n.agent === 'documenter');

    const res = await search(app, { query: 'jwt' });

    expect(res.status).toBe(200);
    expect(res.body.results[0].name).toBe(path.basename(codeNote.note_path, '.md'));
  });

  test("each section is embedded with its note's title, kind, project and summary in front", async () => {
    await writeVaultNote('memos/caching-decision.md', [
      '---',
      'title: "Cache invalidation decision"',
      'kind: "decision"',
      'project: "project-b"',
      '---',
      '',
      '## Summary',
      'We chose write-through caching.',
      '',
      '## Key Points',
      '- Invalidate on write.',
    ].join('\n'));

    // Startup indexes the hand-written note; the search waits for it.
    await search(createApp(cfg), { query: 'cache' });

    const prefix = [
      'Note: Cache invalidation decision',
      'Kind: decision',
      'Project: project-b',
      'Summary: We chose write-through caching.',
    ].join('\n');
    expect(embeddedTexts(mockState)).toEqual(
      expect.arrayContaining([
        `${prefix}\n\n## Summary\nWe chose write-through caching.`,
        `${prefix}\n\n## Key Points\n- Invalidate on write.`,
      ]),
    );
  });

  test('a code note from a run is embedded with the context of the capture it came from', async () => {
    await triggerAndWait(createApp(cfg), PAYLOAD);

    expect(embeddedTexts(mockState)).toContain(
      [
        'Note: JWT Refresh Implementation',
        'Kind: code',
        'Project: project-a',
        'Summary: Implements JWT refresh.',
        '',
        '## Summary',
        'Implements JWT refresh.',
      ].join('\n'),
    );
  });

  test('notes and queries are embedded with the configured model', async () => {
    const app = createApp({ ...cfg, embedModel: 'other-embed' });
    await triggerAndWait(app, PAYLOAD);
    await search(app, { query: 'jwt' });

    expect(mockState.embedCalls.length).toBeGreaterThan(0);
    expect(mockState.embedCalls.every(c => c.model === 'other-embed')).toBe(true);
  });

  /** A hand-written note whose prefix (title, summary) holds no mock vocabulary. */
  function plainNote(title: string, sections: string[]): string {
    return [
      '---',
      `title: "${title}"`,
      'type: "code"',
      'project: "project-a"',
      '---',
      '',
      '## Overview',
      'Notes on tooling.',
      '',
      ...sections,
    ].join('\n');
  }

  test("a note's score is its best section's score, and results are ranked by it", async () => {
    // One section entirely about docker, two about python.
    await writeVaultNote('code/focused.md', plainNote('Focused', [
      '## Containers', 'We run docker.', '',
      '## Scripts', 'python python python', '',
      '## More scripts', 'python python python',
    ]));
    // One section that mentions docker once among python.
    await writeVaultNote('code/mixed.md', plainNote('Mixed', ['## Notes', 'docker python python']));
    // Nothing about docker at all.
    await writeVaultNote('code/unrelated.md', plainNote('Unrelated', ['## Notes', 'rust']));

    const res = await search(createApp(cfg), { query: 'docker' });

    expect(res.body.results.map((r: { name: string }) => r.name)).toEqual(['focused', 'mixed', 'unrelated']);
    // "## Containers / We run docker." is all docker: cosine 1.
    expect(res.body.results[0].score).toBeCloseTo(1, 6);
    // docker 1, python 2: cosine 1 / sqrt(5).
    expect(res.body.results[1].score).toBeCloseTo(0.4472136, 6);
    expect(res.body.results[2].score).toBe(0);
  });

  test('search returns at most the requested number of results, best first', async () => {
    await writeVaultNote('code/one.md', plainNote('One', ['## Notes', 'docker python']));
    await writeVaultNote('code/two.md', plainNote('Two', ['## Notes', 'docker']));
    await writeVaultNote('code/three.md', plainNote('Three', ['## Notes', 'docker python python python']));

    const res = await search(createApp(cfg), { query: 'docker', limit: 2 });

    expect(res.body.results.map((r: { name: string }) => r.name)).toEqual(['two', 'one']);
  });

  test('each result has the note name, kind, project, best-matching snippet and score', async () => {
    await writeVaultNote('code/focused.md', plainNote('Focused', [
      '## Containers', 'We run docker.', '',
      '## Scripts', 'python python python',
    ]));

    const res = await search(createApp(cfg), { query: 'docker' });

    expect(res.body.results).toEqual([
      {
        name: 'focused',
        path: 'code/focused.md',
        kind: 'code',
        project: 'project-a',
        snippet: '## Containers\nWe run docker.',
        score: expect.closeTo(1, 6),
      },
    ]);
  });

  test("research notes never appear in search results, even when they're the best match", async () => {
    const app = createApp(cfg);
    // The run writes a code note and a research note, both about JWT.
    await triggerAndWait(app, PAYLOAD);
    await writeVaultNote('research/by-hand.md', [
      '---', 'title: "JWT"', 'type: "research"', '---', '', '## Overview', 'jwt jwt jwt',
    ].join('\n'));
    await triggerAndWait(app, PAYLOAD);

    const res = await search(createApp(cfg), { query: 'jwt', limit: 50 });

    expect(res.body.results.length).toBeGreaterThan(0);
    for (const r of res.body.results) {
      expect(r.kind).not.toBe('research');
      expect(r.path).not.toMatch(/^research\//);
    }
  });

  test('a section too long for the embedding model is split, so none of it is cut off', async () => {
    // ~5000 characters in one section, well past bge-large's 512 tokens.
    const paragraphs = Array.from({ length: 25 }, (_, i) => `Paragraph ${i}: ${'filler words here '.repeat(10).trim()}.`);
    paragraphs.push('The very end mentions kafka.');
    await writeVaultNote('code/long.md', plainNote('Long', ['## Details', paragraphs.join('\n\n')]));
    // One giant paragraph with no breaks at all.
    await writeVaultNote('code/wall.md', plainNote('Wall', ['## Wall', `${'word '.repeat(1500)}rust`]));

    const res = await search(createApp(cfg), { query: 'kafka' });

    const texts = embeddedTexts(mockState).filter(t => t.startsWith('Note: Long') || t.startsWith('Note: Wall'));
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(2000);
    // Every paragraph made it into some embed input, the last one included.
    for (const p of paragraphs) expect(texts.some(t => t.includes(p))).toBe(true);
    expect(texts.some(t => t.startsWith('Note: Wall') && t.endsWith('rust'))).toBe(true);
    // A later chunk still says which section it came from.
    expect(texts.filter(t => t.includes('## Details')).length).toBeGreaterThan(1);
    // The chunk holding the match is the best section, so the note ranks first.
    expect(res.body.results[0].name).toBe('long');
    const kafkaChunk = texts.find(t => t.includes('kafka'))!;
    const snippetStart = res.body.results[0].snippet.replace(/…$/, '');
    expect(kafkaChunk).toContain(`\n\n${snippetStart}`);
  });

  test('a query that is missing or empty is rejected', async () => {
    const app = createApp(cfg);
    expect((await search(app, {})).status).toBe(400);
    expect((await search(app, { query: '  ' })).status).toBe(400);
  });

  test('a limit that is not a positive whole number is rejected', async () => {
    const app = createApp(cfg);
    for (const limit of [0, -1, 1.5, 'three']) {
      const res = await search(app, { query: 'docker', limit });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('limit');
    }
  });
});
