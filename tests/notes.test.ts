import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { createApp } from '../src/server';
import { Config } from '../src/config';
import { close, createMockOllama, createMockOllamaState, listen, resetMockOllamaState } from './helpers/mock-ollama';

const NOTES_URL = '/webhook/knowledge-graph/notes';

describe('note and related endpoints (end-to-end)', () => {
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
    vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-notes-'));
    resetMockOllamaState(mockState);
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

  async function writeVaultNote(relPath: string, content: string): Promise<void> {
    const full = path.join(vaultDir, relPath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }

  test("the note endpoint returns a note's content and frontmatter by name", async () => {
    await writeVaultNote('memos/cache-decision.md', [
      '---',
      'title: "Cache invalidation decision"',
      'kind: "decision"',
      'project: "project-b"',
      '---',
      '',
      '## Summary',
      'We chose write-through caching.',
    ].join('\n'));

    const res = await request(createApp(cfg)).get(`${NOTES_URL}/cache-decision`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      name: 'cache-decision',
      path: 'memos/cache-decision.md',
      frontmatter: { title: 'Cache invalidation decision', kind: 'decision', project: 'project-b' },
      content: '## Summary\nWe chose write-through caching.',
    });
  });

  test('asking for a note that does not exist is a clear not-found error', async () => {
    await writeVaultNote('code/other.md', '# Other');

    const res = await request(createApp(cfg)).get(`${NOTES_URL}/no-such-note`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No note named "no-such-note"');
  });

  test('names are matched against notes only, so a name cannot reach outside them', async () => {
    await writeVaultNote('.obsidian/workspace.md', 'not a note');
    await fs.writeFile(path.join(os.tmpdir(), 'swarm-outside.md'), 'outside the vault', 'utf8');
    const app = createApp(cfg);

    expect((await request(app).get(`${NOTES_URL}/workspace`)).status).toBe(404);
    expect((await request(app).get(`${NOTES_URL}/${encodeURIComponent('../swarm-outside')}`)).status).toBe(404);
  });
});
