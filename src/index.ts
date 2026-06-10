import { loadConfig } from './config';
import { createApp } from './server';

const cfg = loadConfig();
const app = createApp(cfg);

app.listen(cfg.port, () => {
  console.log(`swarm-kg listening on port ${cfg.port}`);
  console.log(`  vault:  ${cfg.vaultPath}`);
  console.log(`  ollama: ${cfg.ollamaUrl} (${cfg.ollamaModel})`);
});
