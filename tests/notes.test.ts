import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import request from './helpers/http';
import { createApp } from '../src/server';
import { Config, loadConfig } from '../src/config';
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

  afterAll(() => {
    mockServer.closeAllConnections();
    return close(mockServer);
  });

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
      noteMaxChars: 20_000,
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

  test("a note longer than the cap is cut short with a marker saying so", async () => {
    await writeVaultNote('code/long.md', ['---', 'title: "Long"', '---', '', 'a'.repeat(100)].join('\n'));
    await writeVaultNote('code/short.md', ['---', 'title: "Short"', '---', '', 'a'.repeat(40)].join('\n'));
    const app = createApp({ ...cfg, noteMaxChars: 40 });

    const long = await request(app).get(`${NOTES_URL}/long`);
    const short = await request(app).get(`${NOTES_URL}/short`);

    expect(long.body.content).toBe(`${'a'.repeat(40)}\n\n… [truncated: showing 40 of 100 characters]`);
    expect(long.body.truncated).toBe(true);
    expect(long.body.frontmatter).toEqual({ title: 'Long' });
    expect(short.body.content).toBe('a'.repeat(40));
    expect(short.body).not.toHaveProperty('truncated');
  });

  test('the cap on note text is a setting, 20,000 characters by default', () => {
    expect(loadConfig({}).noteMaxChars).toBe(20_000);
    expect(loadConfig({ NOTE_MAX_CHARS: '5000' }).noteMaxChars).toBe(5000);
    expect(loadConfig({ NOTE_MAX_CHARS: 'lots' }).noteMaxChars).toBe(20_000);
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

  test('the related endpoint returns the notes a note links to and the notes that link to it, without session logs', async () => {
    await writeVaultNote('code/2026-06-10_jwt.py.md', [
      '---',
      'title: "JWT refresh"',
      'type: "code"',
      'project: "project-a"',
      '---',
      '',
      '## Summary',
      'Refresh tokens, see [[cache-decision|the caching decision]].',
      '',
      '## Related Notes',
      '- [[2026-06-10_session_log]]',
      '- [[note-that-does-not-exist]]',
    ].join('\n'));
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
    await writeVaultNote('memos/token-learning.md', [
      '---',
      'title: "Token learning"',
      'kind: "learning"',
      'project: "project-a"',
      '---',
      '',
      'Builds on [[2026-06-10_jwt.py#Summary]].',
    ].join('\n'));
    await writeVaultNote('logs/2026-06-10_session_log.md', '- **File:** see [[2026-06-10_jwt.py]]');
    await writeVaultNote('code/unrelated.md', '# Unrelated\nNothing to see.');

    const res = await request(createApp(cfg)).get(`${NOTES_URL}/2026-06-10_jwt.py/related`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      name: '2026-06-10_jwt.py',
      outgoing: [
        { name: 'cache-decision', path: 'memos/cache-decision.md', title: 'Cache invalidation decision', type: null, kind: 'decision', project: 'project-b' },
      ],
      incoming: [
        { name: 'token-learning', path: 'memos/token-learning.md', title: 'Token learning', type: null, kind: 'learning', project: 'project-a' },
      ],
    });
  });

  test('asking for the related notes of a note that does not exist is a clear not-found error', async () => {
    const res = await request(createApp(cfg)).get(`${NOTES_URL}/no-such-note/related`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No note named "no-such-note"');
  });
});
