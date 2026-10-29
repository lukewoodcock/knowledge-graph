/**
 * The command the /remember skill runs: sends the memos the session's agent
 * wrote (JSON on stdin) to the service, waits for the run, and prints each
 * memo's name and links for the agent to report back.
 *
 *   node dist/remember.js --session <id> --project-dir <dir> < memos.json
 *   node dist/remember.js --run <run_id>     # a run that was still going
 *
 * It stamps every memo with the session id and the project, named the same
 * way the capture hook names it, so memos and code captures from one session
 * agree and link up.
 *
 * Exit codes: 0 saved, 1 nothing saved (the output says why), 2 still
 * running when the wait ran out (the output says how to check again).
 */
import { projectName } from './hook/io';
import { positiveInt, serviceUrl } from './env';
import { memoList } from './requests';
import { RunStatus } from './types';

const REQUEST_TIMEOUT_MS = 10_000;
// Under the Bash tool's default two-minute timeout.
const DEFAULT_WAIT_MS = 100_000;

interface Options {
  /** How often to poll the run's status. */
  pollMs?: number;
}

interface RunMemo {
  name: string;
  kind: string;
  links: string[];
}

/** A run as the status URL reports it. */
interface Run {
  status: RunStatus;
  memos?: RunMemo[];
  errors?: string[];
  error?: string;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** The service could not be reached at all. */
class Unreachable extends Error {}

/** The JSON body of a reply from the service; its fields are checked where they're used. */
type ReplyBody = Record<string, unknown>;

/** One request to the service, as status and parsed JSON body ({} when the body isn't JSON). */
async function call(url: string, init?: RequestInit): Promise<{ status: number; ok: boolean; body: ReplyBody }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    throw new Unreachable(String(err));
  }
  const body: unknown = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body: body && typeof body === 'object' ? (body as ReplyBody) : {} };
}

/** Where the service is, where to report, and how long to wait for a run. */
interface ServiceClient {
  base: string;
  log: (line: string) => void;
  pollMs: number;
  waitMs: number;
}

/** Polls a run until it finishes or the wait runs out, then reports it. */
async function waitAndReport(svc: ServiceClient, runId: string, savedFor: string): Promise<number> {
  const { base, log } = svc;
  const deadline = Date.now() + svc.waitMs;
  for (;;) {
    const res = await call(`${base}/webhook/knowledge-graph/runs/${encodeURIComponent(runId)}`);
    if (!res.ok) {
      log(`No run ${runId} at the service (HTTP ${res.status}): ${res.body.error ?? ''}`.trim());
      log("Runs are kept in memory, so a restart forgets them; check the vault's memos folder instead.");
      return 1;
    }
    const run = res.body as unknown as Run;
    if (run.status === 'error') {
      log(`The run failed: ${run.error ?? 'no reason given'}. Nothing was saved.`);
      return 1;
    }
    if (run.status !== 'running') {
      const saved = run.memos ?? [];
      log(`Saved ${saved.length} memo(s) to the graph${savedFor}:`);
      for (const m of saved) {
        log(`- ${m.name} (${m.kind})`);
        log(`  links: ${m.links.length > 0 ? m.links.map(l => `[[${l}]]`).join(', ') : 'none'}`);
      }
      if (run.status === 'partial') {
        log(`The run was partial: the memos above are saved, but ${(run.errors ?? []).join('; ')}`);
      }
      return 0;
    }
    if (Date.now() >= deadline) {
      log(`The memos are queued but the run is still running after ${Math.round(svc.waitMs / 1000)}s`);
      log('(other captures may be ahead of it in the queue). Check again with:');
      log(`node ${__filename} --run ${runId}`);
      return 2;
    }
    await new Promise(resolve => setTimeout(resolve, svc.pollMs));
  }
}

/** Runs the command; returns its exit code. */
export async function remember(
  argv: string[],
  stdin: string,
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = console.log,
  opts: Options = {},
): Promise<number> {
  const svc: ServiceClient = {
    base: serviceUrl(env),
    log,
    pollMs: opts.pollMs ?? 1000,
    waitMs: positiveInt(env.KG_REMEMBER_WAIT_MS, DEFAULT_WAIT_MS),
  };
  const unreachable = (err: Unreachable, what: string) => {
    log(`The knowledge-graph service is not reachable at ${svc.base} (${err.message}). Is it running? ${what}`);
    return 1;
  };

  const runId = flag(argv, '--run');
  if (runId) {
    try {
      return await waitAndReport(svc, runId, '');
    } catch (err) {
      if (err instanceof Unreachable) return unreachable(err, 'Check again once it is.');
      throw err;
    }
  }

  const session = flag(argv, '--session')?.trim();
  // An unsubstituted `${CLAUDE_SESSION_ID}` would link memos to no session.
  if (!session || session.startsWith('${')) {
    log(`--session needs the Claude Code session id (got ${JSON.stringify(session ?? null)}). Nothing was sent.`);
    return 1;
  }

  // The service validates the memos; anything but a list is sent as it is, for it to reject.
  let raw: unknown;
  try {
    raw = memoList(JSON.parse(stdin));
  } catch (err) {
    log(`stdin is not valid JSON (${String(err)}). Nothing was sent.`);
    return 1;
  }
  const project = await projectName(flag(argv, '--project-dir') ?? process.cwd());
  const stamp = (m: unknown) => ({ ...(m && typeof m === 'object' ? m : {}), session_id: session, project });
  const memos = Array.isArray(raw) ? raw.map(stamp) : raw;

  let accepted;
  try {
    accepted = await call(`${svc.base}/webhook/knowledge-graph/memo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memos }),
    });
  } catch (err) {
    if (err instanceof Unreachable) return unreachable(err, 'Nothing was saved.');
    throw err;
  }
  if (!accepted.ok) {
    log(`The service rejected the memos (HTTP ${accepted.status}): ${accepted.body.error ?? 'no reason given'}`);
    log('Nothing was saved. Fix the memos and send them again.');
    return 1;
  }

  const acceptedRunId = String(accepted.body.run_id);
  try {
    return await waitAndReport(svc, acceptedRunId, ` for project ${project}, session ${session}`);
  } catch (err) {
    if (err instanceof Unreachable) {
      return unreachable(err, `The memos were accepted as run ${acceptedRunId}; check the vault's memos folder.`);
    }
    throw err;
  }
}

/** Reads all of stdin, or '' when it's a terminal. */
async function readAll(): Promise<string> {
  if (process.stdin.isTTY) return '';
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

if (require.main === module) {
  void readAll()
    .then(stdin => remember(process.argv.slice(2), stdin))
    .then(code => process.exit(code));
}
