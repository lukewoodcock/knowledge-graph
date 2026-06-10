import express, { Express } from 'express';
import * as path from 'path';
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

export function createApp(cfg: Config): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Same path as the n8n version, so existing IDE integrations keep working.
  app.post('/webhook/knowledge-graph/trigger', async (req, res) => {
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

    try {
      await writeSessionLog(ctx, cfg);

      // Documenter and Researcher run in parallel. allSettled so one agent
      // failing doesn't take down the other's note.
      const settled = await Promise.allSettled([
        runDocumenter(ctx, cfg),
        runResearcher(ctx, cfg),
      ]);

      const notes: NoteResult[] = [];
      const errors: string[] = [];
      for (const result of settled) {
        if (result.status === 'fulfilled') notes.push(result.value);
        else errors.push(String(result.reason));
      }

      const linker = await runLinker(notes, ctx.language, ctx.description, cfg);

      res.json({
        status: errors.length === 0 ? 'complete' : 'partial',
        session_date: ctx.today,
        file_path: ctx.filePath,
        language: ctx.language,
        notes: notes.map(n => ({ agent: n.agent, note_path: n.notePath, title: n.title })),
        linker: { status: linker.status, links_written: linker.linksWritten },
        ...(errors.length > 0 ? { errors } : {}),
      });
    } catch (err) {
      res.status(500).json({ status: 'error', error: String(err) });
    }
  });

  return app;
}
