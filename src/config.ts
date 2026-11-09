import { positiveInt, withoutTrailingSlash } from './env';
import type { ModelEndpoint } from './model-client';

export interface Config {
  /** Address to listen on. Loopback by default, so nothing else on the network can reach the service. */
  host: string;
  port: number;
  vaultPath: string;
  /** The Ollama API the Documenter, Researcher and Linker chat with. */
  chatEndpoint: ModelEndpoint;
  /** The Ollama API that embeds notes and search queries: the chat one unless OLLAMA_EMBED_URL says otherwise. */
  embedEndpoint: ModelEndpoint;
  ollamaModel: string;
  /** Let thinking models (qwen3, deepseek-r1) reason first. Much slower. */
  ollamaThink: boolean;
  /** Ollama model that embeds notes and queries for search. */
  embedModel: string;
  /** Run the Researcher on code captures. Off by default: the graph holds your own work, and runs take about half the time. */
  researcher: boolean;
  /** Most characters of a note's text the note endpoint (and so get_note) returns; the rest is cut with a marker. */
  noteMaxChars: number;
  /** Wait before the first retry of a model call, when the API doesn't say. Not a setting: tests shorten it. */
  retryDelayMs?: number;
}

/** About 5,000 tokens: room for any note a run writes, while a huge hand-written one can't flood an agent's context. */
export const DEFAULT_NOTE_MAX_CHARS = 20_000;

/**
 * The chat and embeddings endpoints. Embeddings share OLLAMA_URL, and its
 * key, unless OLLAMA_EMBED_URL names another endpoint; then only
 * OLLAMA_EMBED_API_KEY goes there, so neither key reaches the other endpoint.
 */
function ollamaEndpoints(env: NodeJS.ProcessEnv): Pick<Config, 'chatEndpoint' | 'embedEndpoint'> {
  const chatUrl = withoutTrailingSlash(env.OLLAMA_URL || 'http://ollama:11434');
  const embedUrl = withoutTrailingSlash(env.OLLAMA_EMBED_URL || chatUrl);
  const chatKey = env.OLLAMA_API_KEY || undefined;
  const embedKey = env.OLLAMA_EMBED_API_KEY || (embedUrl === chatUrl ? chatKey : undefined);
  return { chatEndpoint: endpoint(chatUrl, chatKey), embedEndpoint: endpoint(embedUrl, embedKey) };
}

function endpoint(url: string, apiKey: string | undefined): ModelEndpoint {
  return apiKey ? { url, apiKey } : { url };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST || '127.0.0.1',
    port: positiveInt(env.PORT, 5678),
    vaultPath: env.VAULT_PATH || '/vault',
    ...ollamaEndpoints(env),
    ollamaModel: env.OLLAMA_MODEL || 'qwen3.5:9b',
    ollamaThink: env.OLLAMA_THINK === 'true',
    embedModel: env.OLLAMA_EMBED_MODEL || 'bge-large',
    researcher: env.RESEARCHER_ENABLED === 'true',
    noteMaxChars: positiveInt(env.NOTE_MAX_CHARS, DEFAULT_NOTE_MAX_CHARS),
  };
}
