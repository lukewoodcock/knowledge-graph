export interface Config {
  /** Address to listen on. Loopback by default, so nothing else on the network can reach the service. */
  host: string;
  port: number;
  vaultPath: string;
  ollamaUrl: string;
  ollamaModel: string;
  /** Let thinking models (qwen3, deepseek-r1) reason first. Much slower. */
  ollamaThink: boolean;
  /** Ollama model that embeds notes and queries for search. */
  embedModel: string;
  /** Run the Researcher on code captures. Off by default: the graph holds your own work, and runs take about half the time. */
  researcher: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST || '127.0.0.1',
    port: parseInt(env.PORT || '5678', 10),
    vaultPath: env.VAULT_PATH || '/vault',
    ollamaUrl: env.OLLAMA_URL || 'http://ollama:11434',
    ollamaModel: env.OLLAMA_MODEL || 'qwen3.5:9b',
    ollamaThink: env.OLLAMA_THINK === 'true',
    embedModel: env.OLLAMA_EMBED_MODEL || 'bge-large',
    researcher: env.RESEARCHER_ENABLED === 'true',
  };
}
