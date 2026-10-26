// Claude Code Stop hook: POSTs the files Claude changed this turn to the
// swarm-kg webhook. Run as `node dist/hook/stop.js` with the hook JSON on stdin.
//
// It must never get in Claude's way: it prints nothing to stdout, always
// exits 0 (exit 2 would stop Claude from stopping), and gives up after a
// hard deadline whatever is still pending.
import { promises as fs } from 'fs';
import { extractLastTurn } from './transcript';
import { StopHookInput, buildPayloads, changedFiles, loadHookConfig, skipReason } from './payload';
import { gitDiff, postPayload, projectName, projectRoot, readStdin } from './io';

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

  // The project root: Claude Code's project directory (where the session
  // started, even if the shell has since cd'd elsewhere), else the cwd, up to
  // the top of its git repository. Without either nothing can be captured.
  const sessionDir = process.env.CLAUDE_PROJECT_DIR || input.cwd;
  if (!sessionDir) return log('skip: no project directory');
  const projectDir = await projectRoot(sessionDir);
  const scope = { projectDir, scratchpadDir: input.scratchpad_dir };

  const files = changedFiles(turn, cfg, scope);
  if (files.length === 0) return log('skip: no project files edited this turn');

  const diffs = new Map<string, string>();
  const naming = projectName(projectDir);
  await Promise.all(files.map(async f => diffs.set(f.filePath, await gitDiff(projectDir, f.filePath))));
  const project = await naming;

  const payloads = buildPayloads(turn, { ...scope, diffs, cfg, sessionId: input.session_id, project });
  const results = await Promise.all(payloads.map(p => postPayload(cfg.url, p, cfg.timeoutMs)));
  results.forEach(r => log(r));
}

setTimeout(() => process.exit(0), HARD_DEADLINE_MS).unref();
main()
  .catch(err => {
    if (process.env.SWARM_KG_DEBUG === '1') process.stderr.write(`[swarm-kg hook] error: ${String(err)}\n`);
  })
  .finally(() => process.exit(0));
