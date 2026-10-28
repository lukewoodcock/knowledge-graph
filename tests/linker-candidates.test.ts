import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { createApp } from '../src/server';
import { Config } from '../src/config';
import { close, createMockOllama, createMockOllamaState, listen, resetMockOllamaState } from './helpers/mock-ollama';
import { triggerAndWait } from './helpers/runs';

/** Note names the prompt lists as candidates ("- [[name]] ..." lines), in order. */
function wikilinks(prompt: string): string[] {
  return [...prompt.matchAll(/^- \[\[([^\]]+)\]\]/gm)].map(m => m[1]);
}

describe("the Linker's link candidates (end-to-end)", () => {
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
    vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-linker-'));
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

  /** Writes a note into the vault the way a person editing it by hand would. */
  async function writeVaultNote(relPath: string, body: string): Promise<void> {
    const full = path.join(vaultDir, relPath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, `---\ntype: "code"\n---\n\n${body}\n`, 'utf8');
  }

  /** The user prompt the Linker sent: the run's last chat call. */
  function linkerPrompt(): string {
    return mockState.prompts[mockState.prompts.length - 1];
  }

  // The mock Documenter's note is about "jwt" and nothing else in the mock's vocabulary.
  const PAYLOAD = {
    file_path: 'src/auth/jwt.py',
    language: 'python',
    description: 'JWT token refresh with sliding expiry',
    changed_code: 'def refresh(): pass',
  };

  test('lists only the ten notes most similar to the new note, most similar first', async () => {
    // auth-0 is all about jwt; each next one has one more "docker", so it is
    // a little less similar to the new jwt note.
    for (let i = 0; i < 12; i++) {
      await writeVaultNote(`code/auth-${i}.md`, ['jwt', ...Array(i).fill('docker')].join(' '));
    }
    await writeVaultNote('code/containers.md', 'docker docker');
    await writeVaultNote('code/streams.md', 'kafka rust');

    await triggerAndWait(createApp(cfg), PAYLOAD);

    expect(wikilinks(linkerPrompt())).toEqual([
      'auth-0', 'auth-1', 'auth-2', 'auth-3', 'auth-4',
      'auth-5', 'auth-6', 'auth-7', 'auth-8', 'auth-9',
    ]);
  });

  test('never offers the note itself or a session log, even when they are the most similar', async () => {
    await writeVaultNote('code/auth-notes.md', 'jwt docker');
    const app = createApp(cfg);
    // The first run writes the code note and a session log that mentions JWT;
    // the second rewrites the same note, which is now in the index.
    const first = await triggerAndWait(app, PAYLOAD);
    const self = path.basename(first.body.notes[0].note_path, '.md');
    const log = (await fs.readdir(path.join(vaultDir, 'logs')))[0].replace(/\.md$/, '');

    await triggerAndWait(app, PAYLOAD);

    const candidates = wikilinks(linkerPrompt());
    expect(candidates).toEqual(['auth-notes']);
    expect(candidates).not.toContain(self);
    expect(candidates).not.toContain(log);
  });

  test('with an empty vault the run completes and writes no links', async () => {
    mockState.links = ['[[made-up-note]]'];
    const app = createApp(cfg);
    const first = await triggerAndWait(app, PAYLOAD);
    mockState.linkTargets = [first.body.notes[0].note_path];
    mockState.prompts = [];

    // The vault now holds only the note itself and the session log.
    const res = await triggerAndWait(app, PAYLOAD);

    expect(res.body.status).toBe('complete');
    expect(res.body.linker).toEqual({ status: 'success', links_written: 0 });
    expect(await fs.readFile(first.body.notes[0].note_path, 'utf8')).not.toContain('## Related Notes');
    // Nothing to link to, so the Linker doesn't ask the model at all.
    expect(mockState.prompts).toHaveLength(1);
  });

  test('with a tiny vault only links to a candidate are written', async () => {
    await writeVaultNote('code/containers.md', 'docker');
    const app = createApp(cfg);
    const first = await triggerAndWait(app, PAYLOAD);
    const notePath = first.body.notes[0].note_path;
    const self = path.basename(notePath, '.md');
    const log = (await fs.readdir(path.join(vaultDir, 'logs')))[0].replace(/\.md$/, '');
    mockState.linkTargets = [notePath];
    mockState.links = ['[[containers]]', '[[made-up-note]]', `[[${self}]]`, `[[${log}]]`, '[[containers|again]]'];

    const res = await triggerAndWait(app, PAYLOAD);

    expect(wikilinks(linkerPrompt())).toEqual(['containers']);
    expect(res.body.linker.links_written).toBe(1);
    const content = await fs.readFile(notePath, 'utf8');
    expect(content.slice(content.indexOf('## Related Notes'))).toBe('## Related Notes\n- [[containers]]\n');
  });
});
