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
import { readNote, relatedNotes } from './graph';
import { createEmbeddingIndex, EmbeddingIndex, MAX_SEARCH_LIMIT } from './embedding-index';

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

    const linker = await runLinker(notes, ctx.language, ctx.description, cfg, index);

    // After the Linker, so the indexed content is the note as finally
    // written (the Linker searches with the note's text, so it doesn't need
    // the note indexed first). A note that fails to index is still in the
    // vault, and the next startup sync picks it up.
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

    const runId = randomUUID();
    runs.set(runId, { status: 'running', run_id: runId });
    // Map iterates in insertion order, so the first key is the oldest run.
    if (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value!);

    // Queued runs report 'running' too, so the status contract is unchanged.
    queue = queue.then(async () => {
      const started = Date.now();
      const result = await runSwarm(ctx, cfg, index);
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

  // Recall: ranked notes for a query. Research notes are never returned.
  app.post('/webhook/knowledge-graph/search', async (req, res) => {
    const body = (req.body ?? {}) as { query?: unknown; limit?: unknown };
    const query = optionalString(body.query);
    if (!query) {
      res.status(400).json({ error: 'Payload must include a non-empty query' });
      return;
    }
    const limit = body.limit;
    if (limit !== undefined && !(Number.isInteger(limit) && (limit as number) > 0)) {
      res.status(400).json({ error: `limit must be a whole number from 1 to ${MAX_SEARCH_LIMIT}` });
      return;
    }

    try {
      const results = await index.search(query, { limit: limit as number | undefined });
      res.json({ query, results });
    } catch (err) {
      res.status(502).json({ error: `Search failed: ${String(err)}` });
    }
  });

  // Recall: one note in full, by name.
  app.get('/webhook/knowledge-graph/notes/:name', async (req, res) => {
    try {
      const note = await readNote(cfg.vaultPath, req.params.name);
      if (!note) {
        res.status(404).json({ error: `No note named "${req.params.name}"` });
        return;
      }
      res.json(note);
    } catch (err) {
      res.status(500).json({ error: `Reading the note failed: ${String(err)}` });
    }
  });

  // Recall: the notes a note links to and the notes linking to it, so an
  // agent can walk the graph from a search hit. Session logs are left out.
  app.get('/webhook/knowledge-graph/notes/:name/related', async (req, res) => {
    try {
      const related = await relatedNotes(cfg.vaultPath, req.params.name);
      if (!related) {
        res.status(404).json({ error: `No note named "${req.params.name}"` });
        return;
      }
      res.json(related);
    } catch (err) {
      res.status(500).json({ error: `Reading the related notes failed: ${String(err)}` });
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
