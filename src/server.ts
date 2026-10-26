import express, { Express } from 'express';
import * as http from 'http';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Config } from './config';
import { SwarmContext, NoteResult } from './types';
import { today, appendNote } from './vault';
import { runDocumenter } from './agents/documenter';
import { runResearcher } from './agents/researcher';
import { runLinker } from './agents/linker';

interface WebhookPayload {
  file_path?: string;
  language?: string;
  description?: string;
  changed_code?: string;
}

async function writeSessionLog(ctx: SwarmContext, cfg: Config): Promise<void> {
  const logFile = path.join(cfg.vaultPath, 'logs', `${ctx.today}_session_log.md`);
  const entry = [
    `## ${new Date().toISOString()}`,
    '',
    `- **File:** ${ctx.filePath}`,
    `- **Language:** ${ctx.language}`,
    `- **Description:** ${ctx.description}`,
    '',
  ].join('\n');

  // First entry of the day gets frontmatter; later entries append below it.
  const header = [
    '---',
    `title: "Session Log ${ctx.today}"`,
    `date: ${ctx.today}`,
    'tags: [log, session]',
    'related: []',
    'source: "orchestrator"',
    'type: "log"',
    '---',
    '',
  ].join('\n');

  const fs = await import('fs/promises');
  let needsHeader = false;
  try {
    await fs.access(logFile);
  } catch {
    needsHeader = true;
  }
  await appendNote(logFile, (needsHeader ? header : '') + entry + '\n');
}

/** Result body for a finished swarm run (same shape the sync API returned). */
type RunResult = Record<string, unknown> & { status: 'complete' | 'partial' | 'error' };

type Run = { status: 'running'; run_id: string } | (RunResult & { run_id: string });

// Runs are kept in memory only; enough to poll a recent trigger.
const MAX_RUNS = 100;

async function runSwarm(ctx: SwarmContext, cfg: Config): Promise<RunResult> {
  try {
    await writeSessionLog(ctx, cfg);

    // Documenter and (when on) Researcher run in parallel. allSettled so one
    // agent failing doesn't take down the other's note.
    const settled = await Promise.allSettled([
      runDocumenter(ctx, cfg),
      ...(cfg.researcher ? [runResearcher(ctx, cfg)] : []),
    ]);

    const notes: NoteResult[] = [];
    const errors: string[] = [];
    for (const result of settled) {
      if (result.status === 'fulfilled') notes.push(result.value);
      else errors.push(String(result.reason));
    }

    const linker = await runLinker(notes, ctx.language, ctx.description, cfg);

    return {
      status: errors.length === 0 ? 'complete' : 'partial',
      session_date: ctx.today,
      file_path: ctx.filePath,
      language: ctx.language,
      notes: notes.map(n => ({ agent: n.agent, note_path: n.notePath, title: n.title })),
      linker: { status: linker.status, links_written: linker.linksWritten },
      ...(errors.length > 0 ? { errors } : {}),
    };
  } catch (err) {
    return { status: 'error', error: String(err) };
  }
}

export function createApp(cfg: Config): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const runs = new Map<string, Run>();
  // Every capture joins one queue and runs one at a time, in arrival order,
  // so several runs never compete for one local Ollama. runSwarm never
  // rejects, so a failed run can't stall the runs behind it.
  let queue: Promise<void> = Promise.resolve();

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Same path as the n8n version, so existing IDE integrations keep working.
  // Responds 202 straight away; the agents take seconds to minutes, so poll
  // the status URL for the result.
  app.post('/webhook/knowledge-graph/trigger', (req, res) => {
    const body = (req.body ?? {}) as WebhookPayload;

    if (!body.file_path && !body.description) {
      res.status(400).json({
        error: 'Payload must include at least one of: file_path, description',
      });
      return;
    }

    const ctx: SwarmContext = {
      filePath: body.file_path || '',
      language: body.language || 'unknown',
      description: body.description || '',
      changedCode: body.changed_code || '',
      today: today(),
    };

    const runId = randomUUID();
    runs.set(runId, { status: 'running', run_id: runId });
    // Map iterates in insertion order, so the first key is the oldest run.
    if (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value!);

    // Queued runs report 'running' too, so the status contract is unchanged.
    queue = queue.then(async () => {
      const started = Date.now();
      const result = await runSwarm(ctx, cfg);
      runs.set(runId, { ...result, run_id: runId });
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`run ${runId} ${result.status} in ${secs}s (${ctx.filePath || ctx.description})`);
    });

    res.status(202).json({
      status: 'accepted',
      run_id: runId,
      status_url: `/webhook/knowledge-graph/runs/${runId}`,
    });
  });

  app.get('/webhook/knowledge-graph/runs/:id', (req, res) => {
    const run = runs.get(req.params.id);
    if (!run) {
      res.status(404).json({ error: 'Unknown run_id' });
      return;
    }
    res.json(run);
  });

  return app;
}

/** Creates the app and listens on cfg.host:cfg.port; resolves once it is listening. */
export function startServer(cfg: Config): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(createApp(cfg));
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => resolve(server));
  });
}
