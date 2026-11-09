import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as http from 'http';
import {
  createModelClient,
  DEFAULT_CHAT_TIMEOUT_MS,
  DEFAULT_EMBED_TIMEOUT_MS,
  ModelError,
  showOllamaModel,
} from '../src/model-client';
import { close, listen } from './helpers/mock-ollama';

/** One scripted reply from the mock Ollama. */
interface Scripted {
  status?: number;
  headers?: Record<string, string>;
  /** Sent as JSON unless it's a string. */
  body?: unknown;
  delayMs?: number;
  /** Drop the connection instead of replying. */
  dropConnection?: boolean;
}

interface Received {
  path: string;
  authorization?: string;
  body: any;
  at: number;
}

/** A mock Ollama that gives out scripted replies in order and records what it was sent. */
describe('the model client', () => {
  const OK_CHAT = { body: { message: { role: 'assistant', content: 'hello' }, done: true } };

  let script: Scripted[] = [];
  let received: Received[] = [];
  let url: string;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', async () => {
      received.push({ path: req.url ?? '', authorization: req.headers.authorization, body: JSON.parse(raw || '{}'), at: Date.now() });
      const reply = script.shift() ?? OK_CHAT;
      if (reply.delayMs) await new Promise(resolve => setTimeout(resolve, reply.delayMs));
      if (reply.dropConnection) {
        req.socket.destroy();
        return;
      }
      res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...reply.headers });
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}));
    });
  });

  beforeAll(async () => {
    url = `http://127.0.0.1:${await listen(server)}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    return close(server);
  });
  beforeEach(() => {
    script = [];
    received = [];
  });

  const HI = [{ role: 'user' as const, content: 'hi' }];

  describe('chat', () => {
    test('sends the conversation to Ollama with the output limit, and returns the text and input tokens', async () => {
      script = [{ body: { message: { role: 'assistant', content: '# A note' }, done: true, prompt_eval_count: 42 } }];

      const reply = await createModelClient({ url }).chat('mock', [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ]);

      expect(reply).toEqual({ text: '# A note', toolCalls: [], inputTokens: 42 });
      expect(received).toHaveLength(1);
      expect(received[0].path).toBe('/api/chat');
      expect(received[0].body).toEqual({
        model: 'mock',
        stream: false,
        think: false,
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hi' },
        ],
        options: { num_predict: 8192 },
      });
    });

    test('asks a thinking model to think when told to', async () => {
      await createModelClient({ url }, { think: true }).chat('mock', HI);

      expect(received[0].body.think).toBe(true);
    });

    test('leaves tools out of the request when there are none', async () => {
      await createModelClient({ url }).chat('mock', HI);

      expect(received[0].body).not.toHaveProperty('tools');
    });

    test("offers tools in Ollama's shape and returns the calls the model made", async () => {
      script = [
        {
          body: {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name: 'search_notes', arguments: { query: 'cache' } } }],
            },
            done: true,
          },
        },
      ];
      const parameters = { type: 'object', properties: { query: { type: 'string' } } };

      const reply = await createModelClient({ url }).chat('mock', HI, [
        { name: 'search_notes', description: 'Search the graph', parameters },
      ]);

      expect(reply.toolCalls).toEqual([{ name: 'search_notes', arguments: { query: 'cache' } }]);
      expect(received[0].body.tools).toEqual([
        { type: 'function', function: { name: 'search_notes', description: 'Search the graph', parameters } },
      ]);
    });

    test('a tool loop reaches Ollama by tool name, with the IDs dropped', async () => {
      await createModelClient({ url }).chat('mock', [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: 'searching',
          toolCalls: [{ id: 'call_1', name: 'search_notes', arguments: { query: 'cache' } }],
        },
        { role: 'tool', toolCallId: 'call_1', toolName: 'search_notes', content: 'two hits' },
        { role: 'assistant', content: 'no tools this time' },
      ]);

      expect(received[0].body.messages).toEqual([
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: 'searching',
          tool_calls: [{ function: { name: 'search_notes', arguments: { query: 'cache' } } }],
        },
        { role: 'tool', tool_name: 'search_notes', content: 'two hits' },
        { role: 'assistant', content: 'no tools this time' },
      ]);
    });
  });

  describe('embed', () => {
    test('returns one vector per input, in order', async () => {
      script = [{ body: { embeddings: [[1, 0], [0, 1]] } }];

      const vectors = await createModelClient({ url }).embed('mock-embed', ['first', 'second']);

      expect(vectors).toEqual([[1, 0], [0, 1]]);
      expect(received[0].path).toBe('/api/embed');
      expect(received[0].body).toEqual({ model: 'mock-embed', input: ['first', 'second'], truncate: true });
    });

    test('sends nothing for no input', async () => {
      expect(await createModelClient({ url }).embed('mock-embed', [])).toEqual([]);
      expect(received).toEqual([]);
    });

    test('a reply without one vector per input is a failure', async () => {
      script = [{ body: { embeddings: [[1, 0]] } }];

      await expect(createModelClient({ url }).embed('mock-embed', ['first', 'second'])).rejects.toThrow(/2 embedding/);
    });
  });

  describe('timeouts', () => {
    test('a chat reply slower than the timeout fails, and is not retried', async () => {
      script = [{ ...OK_CHAT, delayMs: 300 }];

      const failure = await failureOf(createModelClient({ url }, { chatTimeoutMs: 30, retryDelayMs: 1 }).chat('mock', HI));

      expect(failure).toBeInstanceOf(ModelError);
      expect(failure.kind).toBe('timeout');
      expect(received).toHaveLength(1);
    });

    test('an embed slower than its own timeout fails', async () => {
      script = [{ body: { embeddings: [[1]] }, delayMs: 300 }];

      const failure = await failureOf(createModelClient({ url }, { embedTimeoutMs: 30 }).embed('mock-embed', ['first']));

      expect(failure.kind).toBe('timeout');
    });

    test('the defaults leave a slow local model room: 600 s for chat, 60 s for embeddings', () => {
      expect(DEFAULT_CHAT_TIMEOUT_MS).toBe(600_000);
      expect(DEFAULT_EMBED_TIMEOUT_MS).toBe(60_000);
    });
  });

  describe('retries', () => {
    const fast = () => createModelClient({ url }, { retryDelayMs: 1 });

    test.each([429, 500, 503])('HTTP %i, then success', async status => {
      script = [{ status, body: { error: 'busy' } }, OK_CHAT];

      const reply = await fast().chat('mock', HI);

      expect(reply.text).toBe('hello');
      expect(received).toHaveLength(2);
    });

    test('a dropped connection, then success', async () => {
      script = [{ dropConnection: true }, OK_CHAT];

      expect((await fast().chat('mock', HI)).text).toBe('hello');
      expect(received).toHaveLength(2);
    });

    test('embeddings are retried too', async () => {
      script = [{ status: 500 }, { body: { embeddings: [[1]] } }];

      expect(await fast().embed('mock-embed', ['first'])).toEqual([[1]]);
    });

    test('gives up after 2 retries, with what went wrong', async () => {
      script = [{ status: 500 }, { status: 500 }, { status: 503, body: { error: 'still down' } }];

      const failure = await failureOf(fast().chat('mock', HI));

      expect(received).toHaveLength(3);
      expect(failure.status).toBe(503);
      expect(failure.message).toContain('still down');
    });

    test.each([401, 403, 400, 404])('HTTP %i is not retried', async status => {
      script = [{ status, body: { error: 'no' } }];

      const failure = await failureOf(fast().chat('mock', HI));

      expect(failure.status).toBe(status);
      expect(received).toHaveLength(1);
    });

    test('waits as long as Retry-After says, in seconds', async () => {
      script = [{ status: 429, headers: { 'Retry-After': '1' } }, OK_CHAT];

      await fast().chat('mock', HI);

      expect(received[1].at - received[0].at).toBeGreaterThanOrEqual(950);
    });

    test('waits until a Retry-After date', async () => {
      const inTwoSeconds = new Date(Date.now() + 2000).toUTCString();
      script = [{ status: 503, headers: { 'Retry-After': inTwoSeconds } }, OK_CHAT];

      await fast().chat('mock', HI);

      // HTTP dates have whole seconds, so this can be up to a second short of two.
      expect(received[1].at - received[0].at).toBeGreaterThanOrEqual(950);
    });

    test('a Retry-After too long to wait for fails now, rather than retrying early', async () => {
      script = [{ status: 429, headers: { 'Retry-After': '3600' } }, OK_CHAT];

      const failure = await failureOf(fast().chat('mock', HI));

      expect(failure.status).toBe(429);
      expect(received).toHaveLength(1);
    });
  });

  describe('replies that can not be used', () => {
    test('a reply cut off by the output limit is a failure, not retried', async () => {
      script = [{ body: { message: { role: 'assistant', content: '# Half a no' }, done: true, done_reason: 'length' } }];

      const failure = await failureOf(createModelClient({ url }, { retryDelayMs: 1 }).chat('mock', HI));

      expect(failure.kind).toBe('cut-off');
      expect(failure.message).toContain('8192');
      expect(received).toHaveLength(1);
    });

    test('a reply that finished normally is not a failure', async () => {
      script = [{ body: { message: { role: 'assistant', content: 'done' }, done: true, done_reason: 'stop' } }];

      expect((await createModelClient({ url }).chat('mock', HI)).text).toBe('done');
    });

    test('a 200 with no message is a failure, carrying what Ollama said', async () => {
      script = [{ body: { error: 'model is loading' } }];

      const failure = await failureOf(createModelClient({ url }).chat('mock', HI));

      expect(failure.kind).toBe('malformed');
      expect(failure.detail).toBe('model is loading');
    });

    test('a 200 that is not JSON is a failure', async () => {
      script = [{ body: '<html>gateway</html>' }];

      expect((await failureOf(createModelClient({ url }).chat('mock', HI))).kind).toBe('malformed');
    });
  });

  describe('the API key', () => {
    const SECRET = 'secret-key';
    const keyed = () => createModelClient({ url, apiKey: SECRET }, { retryDelayMs: 1 });

    test('a chat request carries the key as a bearer token', async () => {
      await keyed().chat('mock', HI);

      expect(received[0].authorization).toBe(`Bearer ${SECRET}`);
    });

    test('an embed request carries the key as a bearer token', async () => {
      script = [{ body: { embeddings: [[1]] } }];

      await keyed().embed('mock-embed', ['first']);

      expect(received[0].authorization).toBe(`Bearer ${SECRET}`);
    });

    test('without a key, no Authorization header is sent', async () => {
      await createModelClient({ url }).chat('mock', HI);

      expect(received[0].authorization).toBeUndefined();
    });

    test.each([
      ['an error reply that echoes it', { status: 401, body: { error: `invalid key ${SECRET}` } }],
      ['a 200 with no message that echoes it', { body: { error: `bad token ${SECRET}` } }],
    ])('never reaches an error, from %s', async (_label, reply) => {
      script = [reply];

      const failure = await failureOf(keyed().chat('mock', HI));

      expect(JSON.stringify({ message: failure.message, detail: failure.detail, text: String(failure) })).not.toContain(SECRET);
      expect(failure.detail).toContain('[redacted]');
    });
  });

  describe("Ollama's model check", () => {
    const endpoint = () => ({ url });

    test('reports what the model can do and that it runs here', async () => {
      script = [{ body: { capabilities: ['completion', 'tools'] } }];

      expect(await showOllamaModel(endpoint(), 'mock', 1000)).toEqual({ capabilities: ['completion', 'tools'], remote: false });
      expect(received[0].path).toBe('/api/show');
      expect(received[0].body).toEqual({ model: 'mock' });
    });

    test.each([
      ['remote_host', { remote_host: 'https://ollama.com:443' }],
      ['remote_model', { remote_model: 'gpt-oss:120b' }],
    ])('reports a model with %s as remote', async (_label, body) => {
      script = [{ body }];

      expect(await showOllamaModel(endpoint(), 'mock', 1000)).toEqual({ capabilities: [], remote: true });
    });

    test('is null for a model that is not pulled', async () => {
      script = [{ status: 404, body: { error: 'not found' } }];

      expect(await showOllamaModel(endpoint(), 'mock', 1000)).toBeNull();
    });

    test('is not retried, so a missing Ollama is reported at once', async () => {
      script = [{ status: 500, body: { error: 'boom' } }];

      expect((await failureOf(showOllamaModel(endpoint(), 'mock', 1000))).status).toBe(500);
      expect(received).toHaveLength(1);
    });
  });
});

/** The ModelError a call failed with; fails the test if it succeeded or threw something else. */
async function failureOf(call: Promise<unknown>): Promise<ModelError> {
  const outcome = await call.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(outcome).toBeInstanceOf(ModelError);
  return outcome as ModelError;
}
