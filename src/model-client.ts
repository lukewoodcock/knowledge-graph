/**
 * The one way anything calls a model. It takes a conversation in a neutral
 * form and returns neutral replies; only ./ollama knows what a request and
 * a reply look like on the wire.
 */
import * as ollama from './ollama';

/** Where a model API is, and the key it takes, if any. The key is only ever sent to this URL. */
export interface ModelEndpoint {
  url: string;
  /** Sent as a bearer token: hosted Ollama (https://ollama.com) needs one, a local Ollama doesn't. */
  apiKey?: string;
}

/** A tool the model may ask for. `parameters` is JSON Schema. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: object;
}

/** A tool call the model made, as it comes back in a reply. */
export interface ReplyToolCall {
  name: string;
  arguments: unknown;
}

/** A tool call in a conversation: the caller gives each its own ID, which ties it to its result. */
export interface ToolCall extends ReplyToolCall {
  id: string;
}

export type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; toolName: string; content: string };

export interface ModelReply {
  text: string;
  toolCalls: ReplyToolCall[];
  /** Tokens the model read to write this reply, when the API reports it. */
  inputTokens?: number;
}

export interface ModelClient {
  chat(model: string, messages: Message[], tools?: ToolDefinition[]): Promise<ModelReply>;
  /** One vector per input, in order. */
  embed(model: string, input: string[]): Promise<number[][]>;
}

export interface ModelClientOptions {
  /** Let thinking models reason first. Much slower. */
  think?: boolean;
  /** Longest wait for one chat reply, on each attempt. */
  chatTimeoutMs?: number;
  /** Longest wait for one embedding reply, on each attempt. */
  embedTimeoutMs?: number;
  /** Wait before the first retry when the API doesn't say; doubles after that. */
  retryDelayMs?: number;
}

/** Most tokens a model may write in one reply. */
export const MAX_OUTPUT_TOKENS = 8192;

/** Long enough for a local thinking model, which is slow, on a cold start. */
export const DEFAULT_CHAT_TIMEOUT_MS = 600_000;
export const DEFAULT_EMBED_TIMEOUT_MS = 60_000;

const DEFAULT_RETRY_DELAY_MS = 500;
const MAX_RETRIES = 2;

/** The longest Retry-After we'll sit out. Longer than this and the call fails, as retrying sooner would be ignoring it. */
const MAX_RETRY_AFTER_MS = 60_000;

export type ModelFailure = 'timeout' | 'unreachable' | 'rejected' | 'malformed' | 'cut-off';

/** Why a model call failed. Its text never holds the endpoint's key. */
export class ModelError extends Error {
  constructor(
    message: string,
    readonly kind: ModelFailure,
    /** What the API or the network said, when it said anything. */
    readonly detail?: string,
    /** The HTTP status, when the API replied with an error. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

type Attempt =
  | { ok: true; body: unknown }
  | { ok: false; error: ModelError; retryable: boolean; retryAfterMs?: number };

/** Retry-After as milliseconds from now: it's either a number of seconds or an HTTP date. */
function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (value.trim() !== '' && Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function networkDetail(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message;
}

/**
 * A ModelError with the endpoint's key taken out of its text, since an API
 * or a proxy may echo the key back in what it says went wrong.
 */
function modelError(
  endpoint: ModelEndpoint,
  summary: string,
  kind: ModelFailure,
  detail?: string,
  status?: number,
): ModelError {
  const redact = (text: string) => (endpoint.apiKey ? text.split(endpoint.apiKey).join('[redacted]') : text);
  const cleanDetail = detail === undefined ? undefined : redact(detail);
  return new ModelError(redact(cleanDetail ? `${summary}: ${cleanDetail}` : summary), kind, cleanDetail, status);
}

/** Makes one attempt, including reading the whole reply, within the timeout. */
async function attempt(endpoint: ModelEndpoint, request: ollama.OllamaRequest, timeoutMs: number): Promise<Attempt> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${endpoint.url}${request.path}`, {
      method: 'POST',
      headers: ollama.requestHeaders(endpoint.apiKey),
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return { ok: false, retryable: false, error: modelError(endpoint, `No reply from the model within ${timeoutMs} ms`, 'timeout') };
    }
    return {
      ok: false,
      retryable: true,
      error: modelError(endpoint, `Could not reach the model API at ${endpoint.url}`, 'unreachable', networkDetail(err)),
    };
  }

  const body = parseJson(text);
  if (!res.ok) {
    return {
      ok: false,
      retryable: res.status === 429 || res.status >= 500,
      retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
      error: modelError(
        endpoint,
        `Model request failed: HTTP ${res.status} ${res.statusText}`,
        'rejected',
        ollama.failureDetail(body),
        res.status,
      ),
    };
  }
  if (body === undefined) {
    return { ok: false, retryable: false, error: modelError(endpoint, 'The model API sent a reply that is not JSON', 'malformed') };
  }
  return { ok: true, body };
}

interface PostOptions {
  timeoutMs: number;
  retries: number;
  retryDelayMs: number;
}

/** POSTs to the API and returns its JSON reply, retrying what's worth retrying; throws a ModelError. */
async function post(endpoint: ModelEndpoint, request: ollama.OllamaRequest, options: PostOptions): Promise<unknown> {
  for (let tries = 0; ; tries++) {
    const result = await attempt(endpoint, request, options.timeoutMs);
    if (result.ok) return result.body;
    if (!result.retryable || tries >= options.retries) throw result.error;
    const waitMs = result.retryAfterMs ?? options.retryDelayMs * 2 ** tries;
    if (waitMs > MAX_RETRY_AFTER_MS) throw result.error;
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
}

export function createModelClient(endpoint: ModelEndpoint, options: ModelClientOptions = {}): ModelClient {
  const {
    think = false,
    chatTimeoutMs = DEFAULT_CHAT_TIMEOUT_MS,
    embedTimeoutMs = DEFAULT_EMBED_TIMEOUT_MS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  } = options;

  return {
    async chat(model, messages, tools) {
      const body = await post(endpoint, ollama.chatRequest(model, messages, tools, think, MAX_OUTPUT_TOKENS), {
        timeoutMs: chatTimeoutMs,
        retries: MAX_RETRIES,
        retryDelayMs,
      });
      const parsed = ollama.parseChatReply(body);
      if (!parsed) {
        throw modelError(endpoint, 'The model API sent no message', 'malformed', ollama.failureDetail(body));
      }
      if (parsed.cutOff) {
        throw modelError(endpoint, `${model} was cut off by the limit of ${MAX_OUTPUT_TOKENS} output tokens`, 'cut-off');
      }
      return parsed.reply;
    },

    async embed(model, input) {
      if (input.length === 0) return [];
      const body = await post(endpoint, ollama.embedRequest(model, input), {
        timeoutMs: embedTimeoutMs,
        retries: MAX_RETRIES,
        retryDelayMs,
      });
      const embeddings = ollama.parseEmbedReply(body);
      if (!Array.isArray(embeddings) || embeddings.length !== input.length) {
        throw modelError(endpoint, `Embedding reply did not hold ${input.length} embedding(s)`, 'malformed');
      }
      return embeddings as number[][];
    },
  };
}

/**
 * Asks Ollama about a model; null when it isn't pulled. Only Ollama has this
 * check. Not retried: it's there to fail fast.
 */
export async function showOllamaModel(
  endpoint: ModelEndpoint,
  model: string,
  timeoutMs: number,
): Promise<ollama.OllamaModelInfo | null> {
  try {
    const body = await post(endpoint, ollama.showRequest(model), { timeoutMs, retries: 0, retryDelayMs: 0 });
    return ollama.parseShowReply(body);
  } catch (err) {
    if (err instanceof ModelError && err.status === 404) return null;
    throw err;
  }
}
