/**
 * `npm run reindex`: asks the running service to rebuild its embedding index
 * from the notes. The service owns the index, so the command goes through
 * its API rather than writing the file itself. With the service stopped,
 * deleting `.swarm-kg/` in the vault and starting the service does the same.
 */

const DEFAULT_SERVICE_URL = 'http://127.0.0.1:5678';
// Embedding a whole vault takes a while on a local model.
const TIMEOUT_MS = 30 * 60 * 1000;

/** Runs the command; returns its exit code. */
export async function reindex(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = console.log,
): Promise<number> {
  const base = (env.SWARM_KG_SERVICE_URL || DEFAULT_SERVICE_URL).replace(/\/+$/, '');
  const url = `${base}/webhook/knowledge-graph/reindex`;
  try {
    const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      log(`reindex failed: HTTP ${res.status} ${body.error ?? ''}`.trim());
      return 1;
    }
    log(`reindex complete: ${body.notes} notes, ${body.embedded} embedded`);
    return 0;
  } catch (err) {
    log(`reindex failed: could not reach the service at ${url} (${String(err)})`);
    return 1;
  }
}

if (require.main === module) {
  void reindex().then(code => process.exit(code));
}
