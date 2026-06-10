import { describe, test, expect } from 'vitest';
import { extractContent } from '../src/ollama';

describe('extractContent', () => {
  test('extracts from native Ollama format', () => {
    expect(extractContent({ message: { content: '# Hello' } })).toBe('# Hello');
  });

  test('extracts from OpenAI-compatible format', () => {
    expect(
      extractContent({ choices: [{ message: { content: '# Hello OAI' } }] }),
    ).toBe('# Hello OAI');
  });

  test('returns empty string for empty object', () => {
    expect(extractContent({})).toBe('');
  });

  test('returns empty string for null/undefined', () => {
    expect(extractContent(null)).toBe('');
    expect(extractContent(undefined)).toBe('');
  });

  test('prefers Ollama format when both are present', () => {
    const resp = {
      message: { content: 'ollama' },
      choices: [{ message: { content: 'openai' } }],
    };
    expect(extractContent(resp)).toBe('ollama');
  });
});
