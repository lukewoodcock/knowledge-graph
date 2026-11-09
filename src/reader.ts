/**
 * The Reader: answers a recall question from the graph with a local Ollama
 * model, so recall needs no cloud model. A small tool loop through the model
 * client: the model searches, opens notes and follows links with the same
 * tools the MCP server offers, then answers citing notes as [[name]]
 * (project).
 */
import { z } from 'zod';
import { GRAPH_TOOLS, GRAPH_TOOL_NAMES, REFERENCE_ONLY, callGraphTool, serviceUnreachable } from './graph-tools';
import { Message, ModelError, ToolCall, ToolDefinition, createModelClient, showOllamaModel } from './model-client';
import { wikilinkTarget } from './vault-format';
import { isLoopback } from './env';

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
  /** How long the step took, in milliseconds: the model's reply and the tool calls it made. */
  ms: number;
  toolCalls: ToolCall[];
}

export const DEFAULT_MAX_STEPS = 8;

/** Long enough for a cold load of a 20 GB model and a long answer. */
export const DEFAULT_OLLAMA_TIMEOUT_MS = 180_000;

/** Answering /healthz or /api/show is instant when they're up. */
const CHECK_TIMEOUT_MS = 5_000;

/** A note the answer cites, found among the notes the Reader opened. */
export interface CitedNote {
  name: string;
  project: string | null;
}

export interface ReaderAnswer {
  answer: string;
  /** The notes the answer cites, in order of first citation. */
  notes: CitedNote[];
  /** Notes the answer cites that the Reader never opened with get_note: possibly made up, or known only by name. */
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

/** The graph tools, their parameters as JSON Schema (as the model writes them: defaults optional). */
const TOOLS: ToolDefinition[] = GRAPH_TOOL_NAMES.map(name => {
  const { description, inputSchema } = GRAPH_TOOLS[name];
  const { $schema: _, ...parameters } = z.toJSONSchema(z.object(inputSchema), { io: 'input' });
  return { name, description, parameters };
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

  const timeoutMs = options.ollamaTimeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS;
  const client = createModelClient({ url: options.ollamaUrl }, { chatTimeoutMs: timeoutMs });
  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: question },
  ];
  // Name to project of every note the Reader opened with get_note.
  const opened = new Map<string, string | null>();
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  let toolCallCount = 0;

  for (let step = 1; ; step++) {
    // Past the cap, the model gets no tools, so it can only answer.
    const final = step > maxSteps;
    if (final) messages.push({ role: 'user', content: ANSWER_NOW });
    const started = Date.now();
    const reply = await explainingFailure(options, timeoutMs, () =>
      client.chat(options.model, messages, final ? undefined : TOOLS),
    );
    const calls: ToolCall[] = final ? [] : reply.toolCalls.map(c => ({ ...c, id: `call_${++toolCallCount}` }));
    messages.push({ role: 'assistant', content: reply.text, toolCalls: calls });
    for (const call of calls) {
      const result = await callGraphTool(options.serviceUrl, call.name, call.arguments);
      if (!result.isError && call.name === 'get_note') recordOpened(result.body, opened);
      messages.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: result.text });
    }
    options.onStep?.({ step, ms: Date.now() - started, toolCalls: calls });
    if (calls.length === 0) {
      const answer = reply.text.trim();
      if (!answer) throw new ReaderError(`${options.model} gave an empty answer. Ask again, or try another model.`);
      return { answer, ...citations(answer, opened) };
    }
  }
}

function requireLoopback(what: string, url: string): void {
  if (!URL.canParse(url)) throw new ReaderError(`The ${what} ${url} is not a URL.`);
  if (!isLoopback(url)) {
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
      'Pick a local model with KG_READER_MODEL.',
  );
}

/** Fails early, before loading a model, when the service isn't up. */
async function checkService(serviceUrl: string): Promise<void> {
  let ok: boolean;
  try {
    ok = (await fetch(`${serviceUrl}/healthz`, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) })).ok;
  } catch (err) {
    throw new ReaderError(serviceUnreachable(serviceUrl, err));
  }
  if (!ok) throw new ReaderError(`The knowledge-graph service at ${serviceUrl} is not healthy.`);
}

/** Asks Ollama about the model: it must be pulled, local, and able to call tools. */
async function checkModel(options: ReaderOptions): Promise<void> {
  const info = await explainingFailure(options, CHECK_TIMEOUT_MS, () =>
    showOllamaModel({ url: options.ollamaUrl }, options.model, CHECK_TIMEOUT_MS),
  );
  if (!info) {
    throw new ReaderError(`${options.model} is not pulled into Ollama. Pull it with: ollama pull ${options.model}`);
  }
  if (info.remote) throw cloudModel(options.model);
  if (!info.capabilities.includes('tools')) {
    throw new ReaderError(`${options.model} can't call tools, so it can't search the graph. Pick another model.`);
  }
}

/** Runs a model call, turning a failure into a ReaderError fit to show the user. */
async function explainingFailure<T>(options: ReaderOptions, timeoutMs: number, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (!(err instanceof ModelError)) throw err;
    switch (err.kind) {
      case 'timeout':
        throw new ReaderError(
          `${options.model} took longer than ${timeoutMs} ms to reply. Raise KG_READER_TIMEOUT_MS, or try a smaller model.`,
        );
      case 'unreachable':
        throw new ReaderError(`Ollama is not reachable at ${options.ollamaUrl}. Is it running? (${err.detail})`);
      case 'cut-off':
        throw new ReaderError(`${err.message}. Ask something narrower, or try another model.`);
      default:
        throw new ReaderError(`Ollama could not answer: ${err.detail ?? 'no reply'}`);
    }
  }
}

/**
 * Records the note a get_note reply holds. Search hits and related notes
 * aren't recorded: the model saw only their names and a snippet, not the note.
 */
function recordOpened(body: unknown, opened: Map<string, string | null>): void {
  const note = body as { name?: unknown; frontmatter?: { project?: string } };
  if (typeof note.name === 'string') opened.set(note.name, note.frontmatter?.project ?? null);
}

/** The notes the answer links to, in order of first citation, split by whether the Reader opened them. */
function citations(answer: string, opened: Map<string, string | null>): Pick<ReaderAnswer, 'notes' | 'unverified'> {
  const names = new Set<string>();
  for (const m of answer.matchAll(/\[\[([^\]]+)\]\]/g)) names.add(wikilinkTarget(m[1]));
  const cited = [...names];
  return {
    notes: cited.filter(n => opened.has(n)).map(name => ({ name, project: opened.get(name) ?? null })),
    unverified: cited.filter(n => !opened.has(n)),
  };
}
