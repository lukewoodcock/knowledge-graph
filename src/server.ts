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
import { createEmbeddingIndex, EmbeddingIndex, MAX_SEARCH_LIMIT } from './embedding-index';
import { Memo, memoLinks, parseMemos, writeMemos } from './memos';

interface WebhookPayload {
  file_path?: string;
  language?: string;
  description?: string;
  changed_code?: string;
  session_id?: string;
  project?: string;
}

/** A non-empty string, or undefined for anything else. */
function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
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

async function runSwarm(ctx: SwarmContext, cfg: Config, index: EmbeddingIndex): Promise<RunResult> {
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

    // After the Linker, so the indexed content is the note as finally
    // written. A note that fails to index is still in the vault, and the
    // next startup sync picks it up.
    try {
      await index.indexNotes(notes.map(n => n.notePath));
    } catch (err) {
      errors.push(`index: ${String(err)}`);
    }

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

/** A memo run: no Documenter or Researcher; each memo is written, linked and indexed. */
async function runMemos(memos: Memo[], date: string, cfg: Config, index: EmbeddingIndex): Promise<RunResult> {
  try {
    const written = await writeMemos(memos, date, cfg);
    const errors: string[] = [];

    // The Linker adds similarity links on top of the session links. A
    // Linker failure leaves the memos written and linked to their session.
    const notes: NoteResult[] = written.map(w => ({
      agent: 'memo',
      status: 'success',
      notePath: w.notePath,
      title: w.memo.title,
    }));
    const description = memos.map(m => `${m.kind} memo: ${m.title}`).join('; ');
    let linker: { status: string; links_written: number };
    try {
      const result = await runLinker(notes, 'unknown', description, cfg);
      linker = { status: result.status, links_written: result.linksWritten };
    } catch (err) {
      errors.push(`linker: ${String(err)}`);
      linker = { status: 'error', links_written: 0 };
    }

    // After the Linker, so the memos are indexed as finally written.
    try {
      await index.indexNotes(written.map(w => w.notePath));
    } catch (err) {
      errors.push(`index: ${String(err)}`);
    }

    return {
      status: errors.length === 0 ? 'complete' : 'partial',
      session_date: date,
      memos: await Promise.all(
        written.map(async w => ({ name: w.name, note_path: w.notePath, kind: w.memo.kind, links: await memoLinks(w) })),
      ),
      linker,
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
  const index = createEmbeddingIndex(cfg);

  // Notes added or edited by hand while the service was down get indexed
  // now. Searches and runs queue behind this inside the index.
  void index.sync().then(
    s => {
      if (s.embedded > 0 || s.removed > 0) {
        console.log(`index: ${s.notes} notes, ${s.embedded} embedded, ${s.removed} removed`);
      }
    },
    err => console.error(`index: startup sync failed: ${String(err)}`),
  );

  // Every capture joins one queue and runs one at a time, in arrival order,
  // so several runs never compete for one local Ollama. runSwarm never
  // rejects, so a failed run can't stall the runs behind it.
  let queue: Promise<void> = Promise.resolve();

  /** Registers a run, queues its work, and returns the 202 body that points at it. */
  function enqueue(label: string, work: () => Promise<RunResult>) {
    const runId = randomUUID();
    runs.set(runId, { status: 'running', run_id: runId });
    // Map iterates in insertion order, so the first key is the oldest run.
    if (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value!);

    // Queued runs report 'running' too, so the status contract is unchanged.
    queue = queue.then(async () => {
      const started = Date.now();
      const result = await work();
      runs.set(runId, { ...result, run_id: runId });
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`run ${runId} ${result.status} in ${secs}s (${label})`);
    });

    return { status: 'accepted', run_id: runId, status_url: `/webhook/knowledge-graph/runs/${runId}` };
  }

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
      session: optionalString(body.session_id),
      project: optionalString(body.project),
    };

    res.status(202).json(enqueue(ctx.filePath || ctx.description, () => runSwarm(ctx, cfg, index)));
  });

  // Memos: captures the session's agent already wrote. Same queue and reply
  // as a code capture; the run writes, links and indexes each memo.
  app.post('/webhook/knowledge-graph/memo', (req, res) => {
    const parsed = parseMemos(req.body);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { memos } = parsed;
    const date = today();
    res.status(202).json(enqueue(`${memos.length} memo(s)`, () => runMemos(memos, date, cfg, index)));
  });

  // Recall: ranked notes for a query. Research notes are never returned.
  app.post('/webhook/knowledge-graph/search', async (req, res) => {
    const body = (req.body ?? {}) as { query?: unknown; limit?: unknown; kind?: unknown };
    const query = optionalString(body.query);
    if (!query) {
      res.status(400).json({ error: 'Payload must include a non-empty query' });
      return;
    }
    // Blank or null means no filter.
    if (body.kind !== undefined && body.kind !== null && typeof body.kind !== 'string') {
      res.status(400).json({ error: 'kind must be a string, e.g. "todo"' });
      return;
    }
    const kind = optionalString(body.kind);
    const limit = body.limit;
    if (limit !== undefined && !(Number.isInteger(limit) && (limit as number) > 0)) {
      res.status(400).json({ error: `limit must be a whole number from 1 to ${MAX_SEARCH_LIMIT}` });
      return;
    }

    try {
      const results = await index.search(query, { limit: limit as number | undefined, kind });
      res.json({ query, ...(kind ? { kind } : {}), results });
    } catch (err) {
      res.status(502).json({ error: `Search failed: ${String(err)}` });
    }
  });

  // Throws the index away and rebuilds it from the notes. Replies when done.
  app.post('/webhook/knowledge-graph/reindex', async (_req, res) => {
    try {
      const { notes, embedded } = await index.rebuild();
      console.log(`index: rebuilt, ${notes} notes embedded`);
      res.json({ status: 'complete', notes, embedded });
    } catch (err) {
      res.status(502).json({ error: `Reindex failed: ${String(err)}` });
    }
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
