import * as path from 'path';
import { Config } from '../config';
import { chat } from '../ollama';
import { safeTitle, writeNote } from '../vault';
import { SwarmContext, NoteResult } from '../types';

const SYSTEM_PROMPT =
  'You are a research assistant for software developers. Given a development context, ' +
  'you produce a structured research note covering best practices, common pitfalls, ' +
  'relevant libraries, and useful patterns. You have broad knowledge up to your ' +
  'training cut-off. Respond ONLY with the markdown document.';

function userPrompt(ctx: SwarmContext): string {
  return `Produce a research note for the following development context.

File: ${ctx.filePath}
Language: ${ctx.language}
Context: ${ctx.description}

Respond with a complete markdown document starting with YAML frontmatter:
---
title: "Research: <concise topic title>"
date: ${ctx.today}
tags: [research, ${ctx.language}, best-practices]
related: []
source: "ollama-research"
type: "research"
---

Then provide:
## Overview
<2-3 sentence overview of the topic>

## Best Practices
- <list of concrete best practices>

## Common Pitfalls
- <list of things to avoid>

## Recommended Libraries / Tools
| Name | Purpose | Notes |
|------|---------|-------|

## Further Reading
- <titles or topics worth exploring (no hallucinated URLs)>
`;
}

/**
 * Researches the current working context and writes a best-practices note
 * to vault/research/.
 */
export async function runResearcher(ctx: SwarmContext, cfg: Config): Promise<NoteResult> {
  const content = await chat(cfg.ollamaUrl, cfg.ollamaModel, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt(ctx) },
  ], cfg.ollamaThink);

  const title = safeTitle(ctx.description || ctx.filePath || 'unknown');
  const notePath = path.join(cfg.vaultPath, 'research', `${ctx.today}_research_${title}.md`);
  await writeNote(notePath, content);

  return { agent: 'researcher', status: 'success', notePath, title };
}
