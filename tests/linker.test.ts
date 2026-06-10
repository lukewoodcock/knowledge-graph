import { describe, test, expect } from 'vitest';
import { parseLinkMap, appendLinks, buildNoteIndex } from '../src/agents/linker';

describe('parseLinkMap', () => {
  const VALID = [
    { new_note_path: '/vault/code/a.md', links_to_add: ['[[b]]', '[[c]]'] },
    { new_note_path: '/vault/research/b.md', links_to_add: [] },
  ];

  test('parses a clean JSON array', () => {
    const result = parseLinkMap(JSON.stringify(VALID));
    expect(result).toHaveLength(2);
    expect(result[0].links_to_add).toEqual(['[[b]]', '[[c]]']);
  });

  test('strips ```json fences', () => {
    expect(parseLinkMap('```json\n' + JSON.stringify(VALID) + '\n```')).toHaveLength(2);
  });

  test('strips plain ``` fences', () => {
    expect(parseLinkMap('```\n' + JSON.stringify(VALID) + '\n```')).toHaveLength(2);
  });

  test('returns [] for non-JSON text', () => {
    expect(parseLinkMap('I think these notes are related because...')).toEqual([]);
  });

  test('returns [] when the LLM returns a JSON object instead of array', () => {
    expect(parseLinkMap('{"links": []}')).toEqual([]);
  });

  test('drops entries without a new_note_path', () => {
    const result = parseLinkMap(JSON.stringify([{ links_to_add: ['[[x]]'] }]));
    expect(result).toEqual([]);
  });

  test('defaults links_to_add to [] when missing', () => {
    const result = parseLinkMap(JSON.stringify([{ new_note_path: '/a.md' }]));
    expect(result[0].links_to_add).toEqual([]);
  });

  test('defaults links_to_add to [] when not an array', () => {
    const result = parseLinkMap(
      JSON.stringify([{ new_note_path: '/a.md', links_to_add: 'oops' }]),
    );
    expect(result[0].links_to_add).toEqual([]);
  });
});

describe('appendLinks', () => {
  test('appends a Related Notes section', () => {
    const updated = appendLinks('# Note\n\nContent.', ['[[b]]', '[[c]]']);
    expect(updated).toContain('## Related Notes');
    expect(updated).toContain('- [[b]]');
    expect(updated).toContain('- [[c]]');
    expect(updated).toContain('# Note\n\nContent.');
  });

  test('returns null when there are no links', () => {
    expect(appendLinks('# Note', [])).toBeNull();
  });

  test('returns null when section already exists (no duplicates)', () => {
    const existing = '# Note\n\n## Related Notes\n- [[x]]\n';
    expect(appendLinks(existing, ['[[y]]'])).toBeNull();
  });
});

describe('buildNoteIndex', () => {
  test('renders wikilink index entries', () => {
    const index = buildNoteIndex(['code/2026-06-10_note.md']);
    expect(index).toBe('- [[2026-06-10_note]] (code/2026-06-10_note.md)');
  });

  test('returns empty string for empty list', () => {
    expect(buildNoteIndex([])).toBe('');
  });

  test('handles files at the vault root', () => {
    expect(buildNoteIndex(['readme.md'])).toBe('- [[readme]] (readme.md)');
  });
});
