import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import * as path from 'path';
import { extractLastTurn, promptText, uniqueFiles, Turn } from '../src/hook/transcript';
import {
  buildPayloads,
  isInside,
  languageFromPath,
  loadHookConfig,
  skipReason,
  truncate,
  DEFAULT_URL,
} from '../src/hook/payload';

const fixture = readFileSync(path.join(__dirname, 'fixtures', 'stop-transcript.jsonl'), 'utf8');

/** Builds a JSONL transcript from plain objects. */
const jsonl = (...lines: object[]) => lines.map(l => JSON.stringify(l)).join('\n') + '\n';
const prompt = (content: unknown, extra: object = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
const toolUse = (id: string, name: string, input: object) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});

describe('extractLastTurn (fixture transcript)', () => {
  const turn = extractLastTurn(fixture)!;

  test('takes the last real prompt, not an earlier one or a meta line', () => {
    expect(turn.prompt).toBe('Add JWT refresh with a sliding expiry window');
  });

  test('collects only this turn’s successful, non-sidechain edits in order', () => {
    expect(turn.edits.map(e => [e.tool, e.filePath])).toEqual([
      ['Edit', '/demo/app/src/auth/jwt.ts'],
      ['Write', '/demo/app/tests/test_jwt.py'],
      ['MultiEdit', '/demo/app/src/auth/jwt.ts'],
      ['NotebookEdit', '/demo/app/notebooks/explore.ipynb'],
    ]);
  });

  test('takes new text from each tool’s input', () => {
    expect(turn.edits[0].content).toBe('const TTL = 900;');
    expect(turn.edits[1].content).toContain('def test_refresh');
    expect(turn.edits[2].content).toContain('return token;');
    expect(turn.edits[3].content).toBe('df.describe()');
  });
});

describe('extractLastTurn (edge cases)', () => {
  test('returns null for an empty or prompt-less transcript', () => {
    expect(extractLastTurn('')).toBeNull();
    expect(extractLastTurn(jsonl(toolUse('t1', 'Write', { file_path: '/a.ts', content: 'x' })))).toBeNull();
  });

  test('a turn with no edits has an empty edit list', () => {
    const t = extractLastTurn(jsonl(prompt('explain this'), toolUse('t1', 'Read', { file_path: '/a.ts' })));
    expect(t).toEqual({ prompt: 'explain this', edits: [], ranCommands: false });
  });

  test('records when the turn began and whether it ran a shell command', () => {
    const t = extractLastTurn(
      jsonl(
        prompt('earlier', { timestamp: '2026-10-28T11:00:00.000Z' }),
        toolUse('t0', 'Bash', { command: 'ls' }),
        prompt('add the limiter', { timestamp: '2026-10-28T11:35:30.110Z' }),
        toolUse('t1', 'Bash', { command: "python3 - <<'EOF' ... EOF" }),
      ),
    );
    expect(t?.startedAt).toBe('2026-10-28T11:35:30.110Z');
    expect(t?.ranCommands).toBe(true);
  });

  test("a subagent's shell commands don't count as the turn's", () => {
    const t = extractLastTurn(jsonl(prompt('go'), { ...toolUse('t1', 'Bash', { command: 'ls' }), isSidechain: true }));
    expect(t?.ranCommands).toBe(false);
  });

  test('skips malformed and half-written lines', () => {
    const t = extractLastTurn(jsonl(prompt('go')) + 'not json\n{"type":"assist');
    expect(t?.prompt).toBe('go');
  });

  test('interrupt markers and tool results are not turn boundaries', () => {
    const t = extractLastTurn(
      jsonl(
        prompt('do it'),
        toolUse('t1', 'Write', { file_path: '/a.ts', content: 'x' }),
        prompt([{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
        prompt([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
      ),
    );
    expect(t?.prompt).toBe('do it');
    expect(t?.edits).toHaveLength(1);
  });

  test('ignores edit tool calls without a file path', () => {
    const t = extractLastTurn(jsonl(prompt('go'), toolUse('t1', 'Edit', { new_string: 'x' })));
    expect(t?.edits).toEqual([]);
  });
});

describe('promptText', () => {
  test('accepts string and text-block content', () => {
    expect(promptText(prompt('  hi  '))).toBe('hi');
    expect(promptText(prompt([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]))).toBe('a\nb');
  });

  test('rejects meta, sidechain, and harness output', () => {
    expect(promptText(prompt('x', { isMeta: true }))).toBeNull();
    expect(promptText(prompt('x', { isSidechain: true }))).toBeNull();
    expect(promptText(prompt('<local-command-stdout>Set model</local-command-stdout>'))).toBeNull();
    expect(promptText(prompt('   '))).toBeNull();
    expect(promptText({ type: 'assistant', message: { content: 'x' } })).toBeNull();
  });

  test('renders slash commands as "/name args"', () => {
    const text = '<command-message>implement</command-message>\n<command-name>/implement</command-name>\n<command-args>the login page</command-args>';
    expect(promptText(prompt(text))).toBe('/implement the login page');
  });
});

describe('uniqueFiles', () => {
  test('dedupes by path, joining new text, in first-seen order', () => {
    const files = uniqueFiles([
      { tool: 'Edit', filePath: '/a', content: '1' },
      { tool: 'Write', filePath: '/b', content: '2' },
      { tool: 'Edit', filePath: '/a', content: '3' },
    ]);
    expect(files.map(f => f.filePath)).toEqual(['/a', '/b']);
    expect(files[0].content).toBe('1\n…\n3');
  });
});

describe('loadHookConfig / skipReason', () => {
  const input = { transcript_path: '/t.jsonl', cwd: '/work/app', hook_event_name: 'Stop', stop_hook_active: false };

  test('defaults', () => {
    const cfg = loadHookConfig({});
    expect(cfg.url).toBe(DEFAULT_URL);
    expect(cfg.disabled).toBe(false);
    expect(cfg.timeoutMs).toBe(2000);
    expect(skipReason(input, cfg)).toBeNull();
  });

  test('honours KG_URL', () => {
    expect(loadHookConfig({ KG_URL: 'http://x/y' }).url).toBe('http://x/y');
  });

  test('skips when disabled, re-entered, or missing a transcript', () => {
    expect(skipReason(input, loadHookConfig({ KG_DISABLE: '1' }))).toMatch(/DISABLE/);
    expect(skipReason({ ...input, stop_hook_active: true }, loadHookConfig({}))).toBe('stop_hook_active');
    expect(skipReason({ ...input, transcript_path: undefined }, loadHookConfig({}))).toMatch(/transcript/);
  });

  test('skips when cwd is the vault or inside it, not a sibling', () => {
    const cfg = loadHookConfig({ KG_VAULT_PATH: '/work/vault' });
    expect(skipReason({ ...input, cwd: '/work/vault' }, cfg)).toMatch(/vault/);
    expect(skipReason({ ...input, cwd: '/work/vault/code' }, cfg)).toMatch(/vault/);
    expect(skipReason({ ...input, cwd: '/work/vault-tools' }, cfg)).toBeNull();
  });
});

describe('isInside / languageFromPath / truncate', () => {
  test('isInside', () => {
    expect(isInside('/a/b/c', '/a/b')).toBe(true);
    expect(isInside('/a/bc', '/a/b')).toBe(false);
    expect(isInside('/a', '/a/b')).toBe(false);
  });

  test('languageFromPath', () => {
    expect(languageFromPath('src/x.ts')).toBe('typescript');
    expect(languageFromPath('a/b.PY')).toBe('python');
    expect(languageFromPath('Dockerfile')).toBe('dockerfile');
    expect(languageFromPath('LICENSE')).toBe('unknown');
  });

  test('truncate leaves short text alone and marks long text', () => {
    expect(truncate('abc', 5)).toBe('abc');
    const out = truncate('a'.repeat(10), 4);
    expect(out.startsWith('aaaa\n')).toBe(true);
    expect(out).toContain('truncated 6 chars');
  });
});

describe('buildPayloads', () => {
  const turn = extractLastTurn(fixture)!;
  const cfg = loadHookConfig({});

  test('one payload per changed file, relative paths, shared description', () => {
    const payloads = buildPayloads(turn, { projectDir: '/demo/app', cfg });
    expect(payloads.map(p => [p.file_path, p.language])).toEqual([
      ['src/auth/jwt.ts', 'typescript'],
      ['tests/test_jwt.py', 'python'],
      ['notebooks/explore.ipynb', 'python'],
    ]);
    for (const p of payloads) expect(p.description).toBe('Add JWT refresh with a sliding expiry window');
  });

  test('prefers the git diff, falling back to tool input', () => {
    const diffs = new Map([['/demo/app/src/auth/jwt.ts', 'diff --git a/src/auth/jwt.ts ...']]);
    const [jwt, test_] = buildPayloads(turn, { projectDir: '/demo/app', diffs, cfg });
    expect(jwt.changed_code).toBe('diff --git a/src/auth/jwt.ts ...');
    expect(test_.changed_code).toContain('def test_refresh');
  });

  test('caps changed_code, description, and file count', () => {
    const big: Turn = {
      prompt: 'p'.repeat(5000),
      edits: Array.from({ length: 8 }, (_, i) => ({ tool: 'Write' as const, filePath: `/w/f${i}.ts`, content: 'x'.repeat(10_000) })),
    };
    const payloads = buildPayloads(big, { projectDir: '/w', cfg });
    expect(payloads).toHaveLength(cfg.maxFiles);
    expect(payloads[0].changed_code.length).toBeLessThan(cfg.maxCodeChars + 100);
    expect(payloads[0].description.length).toBeLessThan(cfg.maxDescriptionChars + 100);
  });

  test('drops files outside the project and files inside the vault', () => {
    const t: Turn = {
      prompt: 'p',
      edits: [
        { tool: 'Write', filePath: '/w/a.go', content: 'x' },
        { tool: 'Write', filePath: '/elsewhere/a.go', content: 'x' },
        { tool: 'Write', filePath: '/w/vault/code/note.md', content: 'x' },
      ],
    };
    const payloads = buildPayloads(t, { projectDir: '/w', cfg: loadHookConfig({ KG_VAULT_PATH: '/w/vault' }) });
    expect(payloads.map(p => p.file_path)).toEqual(['a.go']);
  });

  test('carries the session id and project when known, and leaves them out when not', () => {
    const tagged = buildPayloads(turn, { projectDir: '/demo/app', cfg, sessionId: 'sess-1', project: 'app' });
    for (const p of tagged) expect(p).toMatchObject({ session_id: 'sess-1', project: 'app' });

    for (const p of buildPayloads(turn, { projectDir: '/demo/app', cfg })) {
      expect(p).not.toHaveProperty('session_id');
      expect(p).not.toHaveProperty('project');
    }
  });

  test('no edits, no payloads', () => {
    expect(buildPayloads({ prompt: 'p', edits: [] }, { cfg })).toEqual([]);
  });
});
