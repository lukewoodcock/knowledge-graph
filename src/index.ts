import { loadConfig } from './config';
import { startServer } from './server';

const cfg = loadConfig();

startServer(cfg).then(
  () => {
    console.log(`knowledge-graph listening on ${cfg.host}:${cfg.port}`);
    console.log(`  vault:  ${cfg.vaultPath}`);
    console.log(`  ollama: ${cfg.ollamaUrl} (${cfg.ollamaModel})`);
    console.log(`  researcher: ${cfg.researcher ? 'on' : 'off'}`);
  },
  err => {
    console.error(`knowledge-graph failed to start: ${err}`);
    process.exit(1);
  },
);
