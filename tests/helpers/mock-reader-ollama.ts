import * as http from 'http';
import { replyToEmbed } from './mock-ollama';

/** One scripted chat reply: tool calls for the reader to run, or its answer. */
export interface ScriptedReply {
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  content?: string;
}

export interface MockReaderOllamaState {
  /** Chat replies, given out in order. Once they run out, every reply is an answer saying so. */
  replies: ScriptedReply[];
  /** Every /api/chat request body, in the order they arrived. */
  chatRequests: any[];
  /** Every /api/show request body. */
  showRequests: any[];
  /** The /api/show reply: a pulled local model with tool support unless a test says otherwise. */
  show: { status: number; body: object };
  /** How long each chat reply takes. */
  delayMs: number;
  /** Every embed request received, so the same mock can serve the service's search. */
  embedCalls: Array<{ model: string; input: string[] }>;
}

export function createMockReaderOllamaState(): MockReaderOllamaState {
  return {
    replies: [],
    chatRequests: [],
    showRequests: [],
    show: { status: 200, body: { capabilities: ['completion', 'tools'] } },
    delayMs: 0,
    embedCalls: [],
  };
}

export function resetMockReaderOllamaState(state: MockReaderOllamaState): void {
  Object.assign(state, createMockReaderOllamaState());
}

/**
 * Mock Ollama for the Reader: chat requests get the scripted replies in
 * order, in /api/chat's native shape (tool calls with object arguments);
 * /api/show describes the model; embed requests get the deterministic vectors
 * of the main mock, so the real service can search with it too.
 */
export function createMockReaderOllama(state: MockReaderOllamaState): http.Server {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', async () => {
      if (req.url === '/api/embed') {
        replyToEmbed(state, body, res);
        return;
      }
      const parsed = JSON.parse(body || '{}');
      if (req.url === '/api/show') {
        state.showRequests.push(parsed);
        res.writeHead(state.show.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state.show.body));
        return;
      }

      state.chatRequests.push(parsed);
      const reply = state.replies.shift() ?? { content: 'no more scripted replies' };
      if (state.delayMs > 0) await new Promise(resolve => setTimeout(resolve, state.delayMs));
      const message: Record<string, unknown> = { role: 'assistant', content: reply.content ?? '' };
      if (reply.toolCalls) {
        message.tool_calls = reply.toolCalls.map(c => ({ function: { name: c.name, arguments: c.arguments } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: parsed.model, message, done: true }));
    });
  });
}
