import { Config } from '../config';
import { chat } from '../ollama';
import { captureFields, setFrontmatterFields, writeNote } from '../vault';
import { codeNoteName, notePath as notePathIn, safeTitle } from '../vault-format';
import { SwarmContext, NoteResult } from '../types';

const SYSTEM_PROMPT =
  'You are a technical documentation assistant. Your job is to produce a concise, ' +
  'structured markdown note for a developer knowledge base. Always respond with ' +
  'ONLY the markdown document — no preamble, no explanation outside the document.';

function userPrompt(ctx: SwarmContext): string {
  return `Generate a markdown knowledge-base note for the following development activity.

File: ${ctx.filePath}
Language: ${ctx.language}
Description: ${ctx.description}
Code snippet (may be empty):
\`\`\`
${ctx.changedCode}
\`\`\`

Respond with a complete markdown document that starts with YAML frontmatter in this exact format:
---
title: "<concise title>"
date: ${ctx.today}
tags: [<comma-separated tags>]
related: []
source: "ide-webhook"
type: "code"
---

Then write:
## Summary
<2-4 sentence summary of what this code does>

## Key Points
- <bullet points of important implementation details>

## Notes
<any caveats, TODOs, or observations>
`;
}

/**
 * Summarises the current IDE activity into a structured note and writes it
 * to vault/code/.
 */
export async function runDocumenter(ctx: SwarmContext, cfg: Config): Promise<NoteResult> {
  const content = await chat(cfg.ollamaUrl, cfg.ollamaModel, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt(ctx) },
  ], cfg.ollamaThink);

  const title = safeTitle(ctx.filePath || 'unknown');
  const notePath = notePathIn(cfg.vaultPath, 'code', codeNoteName(ctx.today, ctx.project, ctx.filePath));
  await writeNote(notePath, setFrontmatterFields(content, captureFields('code', ctx)));

  return { agent: 'documenter', status: 'success', notePath, title };
}
