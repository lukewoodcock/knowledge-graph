export interface Config {
  port: number;
  vaultPath: string;
  ollamaUrl: string;
  ollamaModel: string;
  /** Let thinking models (qwen3, deepseek-r1) reason first. Much slower. */
  ollamaThink: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: parseInt(env.PORT || '5678', 10),
    vaultPath: env.VAULT_PATH || '/vault',
    ollamaUrl: env.OLLAMA_URL || 'http://ollama:11434',
    ollamaModel: env.OLLAMA_MODEL || 'qwen3.5:9b',
    ollamaThink: env.OLLAMA_THINK === 'true',
  };
}
