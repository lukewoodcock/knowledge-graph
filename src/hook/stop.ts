// Claude Code Stop hook: POSTs the files Claude changed this turn to the
// swarm-kg webhook. Run as `node dist/hook/stop.js` with the hook JSON on stdin.
//
// It must never get in Claude's way: it prints nothing to stdout, always
// exits 0 (exit 2 would stop Claude from stopping), and gives up after a
// hard deadline whatever is still pending.
import { promises as fs } from 'fs';
import { extractLastTurn } from './transcript';
import { StopHookInput, buildPayloads, changedFiles, loadHookConfig, skipReason } from './payload';
import { gitDiff, postPayload, projectName, readStdin } from './io';

const HARD_DEADLINE_MS = 5000;

async function main(): Promise<void> {
  const cfg = loadHookConfig();
  // stderr only, and only when asked: stdout on a Stop hook can be read as a decision.
  const log = (msg: string): void => {
    if (cfg.debug) process.stderr.write(`[swarm-kg hook] ${msg}\n`);
  };

  const input = JSON.parse((await readStdin(1000)) || '{}') as StopHookInput;
  const skip = skipReason(input, cfg);
  if (skip) return log(`skip: ${skip}`);

  const turn = extractLastTurn(await fs.readFile(input.transcript_path!, 'utf8'));
  if (!turn) return log('skip: no user prompt in transcript');

  const files = changedFiles(turn, cfg);
  if (files.length === 0) return log('skip: no files edited this turn');

  const diffs = new Map<string, string>();
  let project: string | undefined;
  if (input.cwd) {
    const cwd = input.cwd;
    const naming = projectName(cwd);
    await Promise.all(files.map(async f => diffs.set(f.filePath, await gitDiff(cwd, f.filePath))));
    project = await naming;
  }

  const payloads = buildPayloads(turn, { cwd: input.cwd, diffs, cfg, sessionId: input.session_id, project });
  const results = await Promise.all(payloads.map(p => postPayload(cfg.url, p, cfg.timeoutMs)));
  results.forEach(r => log(r));
}

setTimeout(() => process.exit(0), HARD_DEADLINE_MS).unref();
main()
  .catch(err => {
    if (process.env.SWARM_KG_DEBUG === '1') process.stderr.write(`[swarm-kg hook] error: ${String(err)}\n`);
  })
  .finally(() => process.exit(0));
