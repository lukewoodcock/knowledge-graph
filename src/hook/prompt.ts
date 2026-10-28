// Claude Code UserPromptSubmit hook: context injection. Searches the graph
// with the prompt and adds the most relevant notes as additional context.
// Run as `node dist/hook/prompt.js` with the hook JSON on stdin.
//
// Claude waits for this hook before it reads the prompt, so it must never get
// in the way: stdout carries only the additionalContext JSON (or nothing), it
// always exits 0 (exit 2 would block the prompt), and it gives up on a slow
// service after a short timeout, adding nothing.
import { readStdin } from './io';
import { PromptHookInput, SearchResult, loadInjectionConfig, renderContext, searchQuery, skipReason } from './injection';

const HARD_DEADLINE_MS = 3000;

async function main(): Promise<void> {
  const cfg = loadInjectionConfig();
  // stderr only, and only when asked: Claude Code reads stdout as the hook's output.
  const log = (msg: string): void => {
    if (cfg.debug) process.stderr.write(`[swarm-kg prompt hook] ${msg}\n`);
  };

  const input = JSON.parse((await readStdin(500)) || '{}') as PromptHookInput;
  const skip = skipReason(input, cfg);
  if (skip) return log(`skip: ${skip}`);

  const res = await fetch(cfg.searchUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: searchQuery(input), limit: cfg.maxNotes }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!res.ok) return log(`search returned ${res.status}`);
  const body = (await res.json()) as { results?: SearchResult[] };
  const results = Array.isArray(body.results) ? body.results : [];

  const context = renderContext(results, cfg);
  log(`${results.length} results, ${context ? `added ${context.length} chars` : 'none above the threshold'}`);
  if (!context) return;

  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }),
  );
}

setTimeout(() => process.exit(0), HARD_DEADLINE_MS).unref();
main()
  .catch(err => {
    if (process.env.SWARM_KG_DEBUG === '1') process.stderr.write(`[swarm-kg prompt hook] error: ${String(err)}\n`);
  })
  .finally(() => process.exit(0));
