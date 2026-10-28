import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { safeTitle } from '../src/vault-format';
import {
  today,
  renderFrontmatter,
  writeNote,
  appendNote,
  listMarkdownFiles,
} from '../src/vault';

describe('safeTitle', () => {
  test('replaces slashes and spaces with underscores', () => {
    expect(safeTitle('src/auth/jwt.py')).toBe('src_auth_jwt.py');
  });

  test('strips leading and trailing underscores', () => {
    const result = safeTitle('/leading/and/trailing/');
    expect(result).not.toMatch(/^_/);
    expect(result).not.toMatch(/_$/);
  });

  test('removes special characters', () => {
    expect(safeTitle('JWT/OAuth 2.0 refresh!')).not.toMatch(/[/! ]/);
  });

  test('truncates to 60 characters by default', () => {
    expect(safeTitle('a'.repeat(100)).length).toBeLessThanOrEqual(60);
  });

  test('respects a custom max length', () => {
    expect(safeTitle('a'.repeat(100), 20).length).toBeLessThanOrEqual(20);
  });

  test('preserves dots, dashes and underscores', () => {
    expect(safeTitle('my-file_v2.test.ts')).toBe('my-file_v2.test.ts');
  });
});

describe('today', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T15:30:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  test('returns YYYY-MM-DD', () => {
    expect(today()).toBe('2026-06-10');
  });
});

describe('renderFrontmatter', () => {
  test('renders all required keys in vault format', () => {
    const fm = renderFrontmatter({
      title: 'Test Note',
      date: '2026-06-10',
      tags: ['python', 'jwt'],
      related: [],
      source: 'ide-webhook',
      type: 'code',
    });
    expect(fm).toContain('title: "Test Note"');
    expect(fm).toContain('date: 2026-06-10');
    expect(fm).toContain('tags: [python, jwt]');
    expect(fm).toContain('related: []');
    expect(fm).toContain('source: "ide-webhook"');
    expect(fm).toContain('type: "code"');
    expect(fm.startsWith('---')).toBe(true);
    expect(fm.endsWith('---')).toBe(true);
  });

  test('escapes double quotes in title', () => {
    const fm = renderFrontmatter({
      title: 'Say "hello"',
      date: '2026-06-10',
      tags: [],
      related: [],
      source: 's',
      type: 'log',
    });
    expect(fm).toContain(`title: "Say 'hello'"`);
  });
});

describe('file operations', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-test-'));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('writeNote creates missing parent directories', async () => {
    const target = path.join(tmpDir, 'code', 'deep', 'note.md');
    await writeNote(target, '# Hello');
    expect(await fs.readFile(target, 'utf8')).toBe('# Hello');
  });

  test('appendNote appends to an existing file', async () => {
    const target = path.join(tmpDir, 'logs', 'log.md');
    await appendNote(target, 'first\n');
    await appendNote(target, 'second\n');
    expect(await fs.readFile(target, 'utf8')).toBe('first\nsecond\n');
  });

  test('listMarkdownFiles returns only .md files, recursively, vault-relative', async () => {
    await writeNote(path.join(tmpDir, 'code', 'a.md'), 'a');
    await writeNote(path.join(tmpDir, 'research', 'b.md'), 'b');
    await writeNote(path.join(tmpDir, 'code', 'image.png'), 'binary');
    const files = await listMarkdownFiles(tmpDir);
    expect(files).toEqual(['code/a.md', 'research/b.md']);
  });

  test('listMarkdownFiles returns [] for a missing directory', async () => {
    expect(await listMarkdownFiles(path.join(tmpDir, 'nope'))).toEqual([]);
  });
});
