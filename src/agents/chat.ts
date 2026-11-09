import { Config } from '../config';
import { createModelClient, Message } from '../model-client';

/** Asks the run's model and returns the text of its reply. Throws if the call fails, or the reply was cut off. */
export async function agentChat(cfg: Config, messages: Message[]): Promise<string> {
  const client = createModelClient(cfg.chatEndpoint, { think: cfg.ollamaThink, retryDelayMs: cfg.retryDelayMs });
  return (await client.chat(cfg.ollamaModel, messages)).text;
}
