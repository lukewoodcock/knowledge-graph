/**
 * The Reader: answers a recall question from the graph with a local Ollama
 * model, so recall needs no cloud model. A small tool loop over Ollama's
 * native /api/chat: the model searches, opens notes and follows links with
 * the same tools the MCP server offers, then answers citing notes as
 * [[name]] (project).
 */
import { z } from 'zod';
import { GRAPH_TOOLS, GRAPH_TOOL_NAMES, REFERENCE_ONLY, callGraphTool, errorMessage } from './graph-tools';
import { wikilinkTarget } from './vault-format';

export interface ReaderOptions {
  /** The service's base URL, as serviceUrl() gives it. */
  serviceUrl: string;
  ollamaUrl: string;
  model: string;
  /** Most turns the model may spend calling tools before it must answer. */
  maxSteps?: number;
  /** Longest wait for one reply from the model, loading it included. */
  ollamaTimeoutMs?: number;
  /** Called as each step finishes. */
  onStep?: (step: ReaderStep) => void;
}

/** One turn of the model: the tool calls it made, none when it answered. */
export interface ReaderStep {
  step: number;
  /** How long the model took to reply, in milliseconds. */
  ms: number;
  toolCalls: Array<{ name: string; arguments: unknown }>;
}

export const DEFAULT_MAX_STEPS = 8;

/** Long enough for a cold load of a 20 GB model and a long answer. */
export const DEFAULT_OLLAMA_TIMEOUT_MS = 180_000;

/** Answering /healthz or /api/show is instant when they're up. */
const CHECK_TIMEOUT_MS = 5_000;

/** A note the answer cites, found among the notes the Reader retrieved. */
export interface CitedNote {
  name: string;
  project: string | null;
}

export interface ReaderAnswer {
  answer: string;
  /** The notes the answer cites, in order of first citation. */
  notes: CitedNote[];
  /** Notes the answer cites that the Reader never retrieved: possibly made up. */
  unverified: string[];
}

const SYSTEM_PROMPT = [
  "You answer the user's question from their knowledge graph: notes written from their past coding sessions across projects.",
  'Search it with search_notes, open the notes that bear on the question with get_note, and follow links with related_notes when a note does not hold the whole answer.',
  'Then answer from the notes only, citing the note behind every statement as [[name]] (project).',
  "Say what the notes don't cover. Don't end with a list of the notes: that list is added for you.",
  REFERENCE_ONLY,
].join(' ');

const ANSWER_NOW =
  'That is all the searching there is time for. Answer now from the notes you have read, citing them; ' +
  "say what the notes don't cover.";

interface ToolCall {
  function: { name: string; arguments?: unknown };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

/** The tools in /api/chat's shape, their parameters as JSON Schema (as the model writes them: defaults optional). */
const OLLAMA_TOOLS = GRAPH_TOOL_NAMES.map(name => {
  const { description, inputSchema } = GRAPH_TOOLS[name];
  const { $schema: _, ...parameters } = z.toJSONSchema(z.object(inputSchema), { io: 'input' });
  return { type: 'function', function: { name, description, parameters } };
});

/** Why the Reader can't answer: its message is fit to show the user as it is. */
export class ReaderError extends Error {}

/**
 * Answers `question` from the graph. Refuses, before any note is read, to
 * talk to anything that isn't on this machine: an Ollama or service URL
 * that isn't loopback, or an Ollama cloud model. Throws a ReaderError when
 * it can't answer.
 */
export async function ask(question: string, options: ReaderOptions): Promise<ReaderAnswer> {
  requireLoopback('Ollama URL', options.ollamaUrl);
  requireLoopback('service URL', options.serviceUrl);
  if (CLOUD_MODEL.test(options.model)) throw cloudModel(options.model);
  await checkService(options.serviceUrl);
  await checkModel(options);

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: question },
  ];
  const retrieved = new Map<string, string | null>();
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;

  for (let step = 1; ; step++) {
    // Past the cap, the model gets no tools, so it can only answer.
    const final = step > maxSteps;
    if (final) messages.push({ role: 'user', content: ANSWER_NOW });
    const started = Date.now();
    const reply = await chat(options, messages, !final);
    messages.push(reply);
    const calls = final ? [] : (reply.tool_calls ?? []);
    options.onStep?.({
      step,
      ms: Date.now() - started,
      toolCalls: calls.map(c => ({ name: c.function.name, arguments: c.function.arguments })),
    });
    if (calls.length === 0) {
      const answer = (reply.content ?? '').trim();
      return { answer, ...citations(answer, retrieved) };
    }
    for (const call of calls) {
      const result = await callGraphTool(options.serviceUrl, call.function.name, call.function.arguments);
      if (!result.isError) remember(result.body, retrieved);
      messages.push({ role: 'tool', tool_name: call.function.name, content: result.text });
    }
  }
}

/** Loopback names and addresses: 127.0.0.0/8, ::1 and localhost. */
const LOOPBACK = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/;

function requireLoopback(what: string, url: string): void {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new ReaderError(`The ${what} ${url} is not a URL.`);
  }
  if (!LOOPBACK.test(hostname)) {
    throw new ReaderError(
      `The ${what} ${url} is not on this machine. The Reader only talks to loopback addresses ` +
        '(127.0.0.1, ::1, localhost), so notes never leave this computer.',
    );
  }
}

/** Ollama names its cloud models with a "cloud" tag or tag suffix: "gpt-oss:120b-cloud", "deepseek-v3.1:671b-cloud". */
const CLOUD_MODEL = /[:-]cloud$/;

function cloudModel(model: string): ReaderError {
  return new ReaderError(
    `${model} is an Ollama cloud model: it runs on Ollama's servers, so the notes would leave this machine. ` +
      'Pick a local model with SWARM_KG_READER_MODEL.',
  );
}

/** Fails early, before loading a model, when the service isn't up. */
async function checkService(serviceUrl: string): Promise<void> {
  let ok: boolean;
  try {
    ok = (await fetch(`${serviceUrl}/healthz`, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) })).ok;
  } catch (err) {
    throw new ReaderError(`The swarm-kg service is not reachable at ${serviceUrl}. Is it running? (${errorMessage(err)})`);
  }
  if (!ok) throw new ReaderError(`The swarm-kg service at ${serviceUrl} is not healthy.`);
}

/** Asks Ollama about the model: it must be pulled, local, and able to call tools. */
async function checkModel(options: ReaderOptions): Promise<void> {
  const { status, body } = await ollama(options, '/api/show', { model: options.model }, CHECK_TIMEOUT_MS);
  const show = body as { capabilities?: string[]; remote_host?: string; remote_model?: string; error?: string };
  if (status === 404) {
    throw new ReaderError(`${options.model} is not pulled into Ollama. Pull it with: ollama pull ${options.model}`);
  }
  if (status !== 200) throw ollamaFailed(show);
  if (show.remote_host || show.remote_model) throw cloudModel(options.model);
  if (!show.capabilities?.includes('tools')) {
    throw new ReaderError(`${options.model} can't call tools, so it can't search the graph. Pick another model.`);
  }
}

async function chat(options: ReaderOptions, messages: ChatMessage[], withTools: boolean): Promise<ChatMessage> {
  const request = {
    model: options.model,
    stream: false,
    think: false,
    messages,
    ...(withTools && { tools: OLLAMA_TOOLS }),
  };
  const timeoutMs = options.ollamaTimeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS;
  const { status, body } = await ollama(options, '/api/chat', request, timeoutMs);
  const reply = body as { message?: ChatMessage; error?: string };
  if (status !== 200 || !reply.message) throw ollamaFailed(reply);
  return reply.message;
}

/** POSTs to Ollama and returns its status and JSON reply; throws a ReaderError when it can't. */
async function ollama(
  options: ReaderOptions,
  path: string,
  request: object,
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  try {
    const res = await fetch(`${options.ollamaUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new ReaderError(
        `${options.model} took longer than ${timeoutMs} ms to reply. Raise SWARM_KG_READER_TIMEOUT_MS, or try a smaller model.`,
      );
    }
    throw new ReaderError(`Ollama is not reachable at ${options.ollamaUrl}. Is it running? (${errorMessage(err)})`);
  }
}

function ollamaFailed(body: { error?: string }): ReaderError {
  return new ReaderError(`Ollama could not answer: ${body.error ?? 'no reply'}`);
}

/** Records the name and project of every note a tool reply mentions. */
function remember(body: unknown, retrieved: Map<string, string | null>): void {
  const b = body as {
    name?: string;
    frontmatter?: { project?: string };
    results?: Array<{ name: string; project?: string | null }>;
    outgoing?: Array<{ name: string; project?: string | null }>;
    incoming?: Array<{ name: string; project?: string | null }>;
  };
  if (typeof b.name === 'string' && b.frontmatter) retrieved.set(b.name, b.frontmatter.project ?? null);
  for (const n of [...(b.results ?? []), ...(b.outgoing ?? []), ...(b.incoming ?? [])]) {
    retrieved.set(n.name, n.project ?? null);
  }
}

/** The notes the answer links to, in order of first citation, split by whether the Reader retrieved them. */
function citations(answer: string, retrieved: Map<string, string | null>): Pick<ReaderAnswer, 'notes' | 'unverified'> {
  const names = new Set<string>();
  for (const m of answer.matchAll(/\[\[([^\]]+)\]\]/g)) names.add(wikilinkTarget(m[1]));
  const cited = [...names];
  return {
    notes: cited.filter(n => retrieved.has(n)).map(name => ({ name, project: retrieved.get(name) ?? null })),
    unverified: cited.filter(n => !retrieved.has(n)),
  };
}
