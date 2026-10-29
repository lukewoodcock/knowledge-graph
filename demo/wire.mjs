#!/usr/bin/env node
// Writes a demo project's knowledge-graph config from the files in examples/, with
// the placeholders filled in. Used by setup.sh and injection.sh.
//
//   node demo/wire.mjs project   <project-dir> <vault-dir> <service-url>
//   node demo/wire.mjs injection <project-dir> on|off [min-score]
import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = path.join(REPO, 'examples');
const PLACEHOLDER = '/ABSOLUTE/PATH/TO/knowledge-graph';

const readJson = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const writeJson = async (p, v) => {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, `${JSON.stringify(v, null, 2)}\n`);
};

/** The capture hook, recall (MCP server and /recall) and /remember, from examples/. */
async function wireProject(projectDir, vaultDir, serviceUrl) {
  // .mcp.json: the knowledge-graph MCP server.
  const mcp = await readJson(path.join(EXAMPLES, 'mcp.json'));
  const server = mcp.mcpServers['knowledge-graph'];
  server.args = server.args.map(a => a.replace(PLACEHOLDER, REPO));
  server.env.KG_SERVICE_URL = serviceUrl;
  await writeJson(path.join(projectDir, '.mcp.json'), mcp);

  // .claude/settings.json: permissions, the MCP server, the capture hook.
  // `env` reaches the Bash tool, so /remember's command finds the service too.
  const settings = await readJson(path.join(EXAMPLES, 'claude-settings.json'));
  settings.env = { KG_SERVICE_URL: serviceUrl };
  for (const entry of settings.hooks.Stop) {
    for (const hook of entry.hooks) {
      hook.command = hook.command
        .replace('/ABSOLUTE/PATH/TO/vault', vaultDir)
        .replace(PLACEHOLDER, REPO)
        .replace(/^/, `KG_URL=${serviceUrl}/webhook/knowledge-graph/trigger `);
    }
  }
  await writeJson(path.join(projectDir, '.claude', 'settings.json'), settings);

  // Both skills, with this repo's path in place of the placeholder.
  for (const skill of ['recall', 'remember']) {
    const from = path.join(EXAMPLES, 'skills', skill, 'SKILL.md');
    const to = path.join(projectDir, '.claude', 'skills', skill, 'SKILL.md');
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.writeFile(to, (await fs.readFile(from, 'utf8')).replaceAll(PLACEHOLDER, REPO));
  }
}

/** Adds or removes the context-injection hook entry, from examples/, in the project's settings. */
async function toggleInjection(projectDir, state, minScore) {
  const settingsPath = path.join(projectDir, '.claude', 'settings.json');
  const settings = await readJson(settingsPath);
  const serviceUrl = settings.env?.KG_SERVICE_URL ?? 'http://127.0.0.1:5678';
  settings.hooks ??= {};
  if (state === 'on') {
    const example = await readJson(path.join(EXAMPLES, 'claude-settings.context-injection.json'));
    const vars = [`KG_SERVICE_URL=${serviceUrl}`, ...(minScore ? [`KG_MIN_SCORE=${minScore}`] : [])];
    for (const entry of example.hooks.UserPromptSubmit) {
      for (const hook of entry.hooks) hook.command = `${vars.join(' ')} ${hook.command.replace(PLACEHOLDER, REPO)}`;
    }
    settings.hooks.UserPromptSubmit = example.hooks.UserPromptSubmit;
  } else {
    delete settings.hooks.UserPromptSubmit;
  }
  await writeJson(settingsPath, settings);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'project' && args.length === 3) {
  await wireProject(path.resolve(args[0]), path.resolve(args[1]), args[2]);
} else if (cmd === 'injection' && args.length >= 2 && ['on', 'off'].includes(args[1])) {
  await toggleInjection(path.resolve(args[0]), args[1], args[2]);
} else {
  console.error('usage: wire.mjs project <project-dir> <vault-dir> <service-url>\n' +
    '       wire.mjs injection <project-dir> on|off [min-score]');
  process.exit(1);
}
