import type { Reporter, TestModule } from 'vitest/node';

/**
 * Prints the full name of every failed test as the last lines of a run, so
 * they survive `tail`, `grep` or a truncated CI log.
 */
export default class FailedNamesReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const failed = testModules.flatMap(m =>
      [...m.children.allTests('failed')].map(t => `${m.moduleId.split('/tests/').pop()} > ${t.fullName}`),
    );
    if (failed.length === 0) return;
    console.log(`\nFailed tests (${failed.length}):`);
    for (const name of failed) console.log(`  FAILED ${name}`);
  }
}
