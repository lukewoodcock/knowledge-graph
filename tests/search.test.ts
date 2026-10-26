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
});
