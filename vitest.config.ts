import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Worktrees made by agent sessions hold their own copy of the tests.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
    // In CI vitest also adds its github-actions reporter, which annotates
    // failures on the PR. The JSON report keeps the last run's results on
    // disk however the console output was captured.
    reporters: [
      'default',
      './tests/reporters/failed-names.ts',
      ['json', { outputFile: 'test-results/results.json' }],
    ],
  },
});
