import * as http from 'http';

/**
 * Words the mock embed endpoint knows. A text's vector counts how often each
 * one appears in it (case-insensitive), so ranking in tests is predictable:
 * a query for "docker" scores a section by how much of its vocabulary is
 * "docker". Text with none of these words gets the zero vector.
 */
export const EMBED_VOCAB = ['jwt', 'docker', 'python', 'cache', 'kafka', 'rust', 'react', 'postgres'];

export function mockVector(text: string): number[] {
  const lower = text.toLowerCase();
  return EMBED_VOCAB.map(word => lower.split(word).length - 1);
}

export interface MockOllamaState {
  /** Note paths the Linker reply suggests links for. */
  linkTargets: string[];
  /** Links the Linker reply suggests for each of them. */
  links: string[];
  /** How long each chat reply takes, so runs that overlap would interleave. */
  delayMs: number;
  /** The user prompt of every chat request, in the order they arrived. */
  prompts: string[];
  /** Every embed request received, in order. */
  embedCalls: Array<{ model: string; input: string[] }>;
}

export function createMockOllamaState(): MockOllamaState {
  return { linkTargets: [], links: ['[[existing-note]]'], delayMs: 0, prompts: [], embedCalls: [] };
}

/** Resets the state in place, so a shared mock starts each test clean. */
export function resetMockOllamaState(state: MockOllamaState): void {
  Object.assign(state, createMockOllamaState());
}

/** Every text sent to the embed endpoint, flattened across calls. */
export function embeddedTexts(state: MockOllamaState): string[] {
  return state.embedCalls.flatMap(c => c.input);
}

/** Replies to POST /api/embed with deterministic vectors, recording the call. */
export function replyToEmbed(
  state: Pick<MockOllamaState, 'embedCalls'>,
  body: string,
  res: http.ServerResponse,
): void {
  const parsed = JSON.parse(body || '{}');
  const input: string[] = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
  state.embedCalls.push({ model: parsed.model, input });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ model: parsed.model, embeddings: input.map(mockVector) }));
}

/**
 * Mock Ollama: embed requests get deterministic vectors; chat requests are
 * answered by inspecting the system prompt, mimicking how each agent gets a
 * different reply.
 */
export function createMockOllama(state: MockOllamaState): http.Server {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', async () => {
      if (req.url === '/api/embed') {
        replyToEmbed(state, body, res);
        return;
      }

      const parsed = JSON.parse(body || '{}');
      const system: string = parsed.messages?.[0]?.content ?? '';
      state.prompts.push(parsed.messages?.[1]?.content ?? '');
      if (state.delayMs > 0) await new Promise(resolve => setTimeout(resolve, state.delayMs));

      let content: string;
      if (system.includes('documentation assistant')) {
        content = [
          '---',
          'title: "JWT Refresh Implementation"',
          'date: 2026-06-10',
          'tags: [python, jwt]',
          'related: []',
          'source: "ide-webhook"',
          'type: "code"',
          '---',
          '',
          '## Summary',
          'Implements JWT refresh.',
        ].join('\n');
      } else if (system.includes('research assistant')) {
        content = [
          '---',
          'title: "Research: JWT Refresh"',
          'date: 2026-06-10',
          'tags: [research, python, best-practices]',
          'related: []',
          'source: "ollama-research"',
          'type: "research"',
          '---',
          '',
          '## Overview',
          'JWTs are stateless tokens.',
        ].join('\n');
      } else {
        // Linker: suggest links for whichever note paths the test configured.
        const linkMap = state.linkTargets.map(p => ({
          new_note_path: p,
          links_to_add: state.links,
        }));
        content = JSON.stringify(linkMap);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'mock', message: { role: 'assistant', content }, done: true }));
    });
  });
}

/** Starts a server on a free port and returns the port. */
export async function listen(server: http.Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

export function close(server: http.Server): Promise<void> {
  return new Promise<void>(resolve => server.close(() => resolve()));
}
