export interface Config {
  port: number;
  vaultPath: string;
  ollamaUrl: string;
  ollamaModel: string;
  /** Let thinking models (qwen3, deepseek-r1) reason first. Much slower. */
  ollamaThink: boolean;
  /** Run the Researcher on code captures. Off by default: the graph holds your own work, and runs take about half the time. */
  researcher: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: parseInt(env.PORT || '5678', 10),
    vaultPath: env.VAULT_PATH || '/vault',
    ollamaUrl: env.OLLAMA_URL || 'http://ollama:11434',
    ollamaModel: env.OLLAMA_MODEL || 'qwen3.5:9b',
    ollamaThink: env.OLLAMA_THINK === 'true',
    researcher: env.RESEARCHER_ENABLED === 'true',
  };
}
