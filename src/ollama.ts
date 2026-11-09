/**
 * Ollama's API style: what its requests and replies look like. Nothing here
 * touches the network, and nothing outside this file knows these formats;
 * the model client does the sending.
 */
import type { Message, ModelReply, ToolDefinition } from './model-client';

/** An HTTP POST to make to Ollama. */
export interface OllamaRequest {
  path: string;
  body: object;
}

export function requestHeaders(apiKey: string | undefined): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

/** A message as /api/chat takes it: tool calls without IDs, tool results by tool name. */
function toOllamaMessage(message: Message): object {
  switch (message.role) {
    case 'tool':
      return { role: 'tool', tool_name: message.toolName, content: message.content };
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        ...(message.toolCalls?.length && {
          tool_calls: message.toolCalls.map(c => ({ function: { name: c.name, arguments: c.arguments } })),
        }),
      };
    default:
      return message;
  }
}

/** `think` is sent explicitly: Ollama ignores it for non-thinking models. */
export function chatRequest(
  model: string,
  messages: Message[],
  tools: ToolDefinition[] | undefined,
  think: boolean,
  maxOutputTokens: number,
): OllamaRequest {
  return {
    path: '/api/chat',
    body: {
      model,
      stream: false,
      think,
      messages: messages.map(toOllamaMessage),
      ...(tools && { tools: tools.map(t => ({ type: 'function', function: t })) }),
      options: { num_predict: maxOutputTokens },
    },
  };
}

interface OllamaChatReply {
  message?: {
    content?: string;
    tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
  };
  prompt_eval_count?: number;
  done_reason?: string;
}

/** The reply in a /api/chat response and whether the output limit cut it off; undefined if it holds no message. */
export function parseChatReply(body: unknown): { reply: ModelReply; cutOff: boolean } | undefined {
  const parsed = body as OllamaChatReply | null;
  if (!parsed?.message) return undefined;
  const { content, tool_calls } = parsed.message;
  return {
    reply: {
      text: content ?? '',
      toolCalls: (tool_calls ?? []).map(c => ({ name: c.function?.name ?? '', arguments: c.function?.arguments })),
      inputTokens: parsed.prompt_eval_count,
    },
    cutOff: parsed.done_reason === 'length',
  };
}

// Truncation is Ollama's default, but sections are chunked to fit, so it's
// only a backstop; sent explicitly in case the default changes.
export function embedRequest(model: string, input: string[]): OllamaRequest {
  return { path: '/api/embed', body: { model, input, truncate: true } };
}

/** The vectors in an /api/embed reply. */
export function parseEmbedReply(body: unknown): unknown {
  return (body as { embeddings?: unknown } | null)?.embeddings;
}

/** What an Ollama error reply says went wrong. */
export function failureDetail(body: unknown): string | undefined {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === 'string' ? error : undefined;
}

/** What Ollama says about a pulled model. */
export interface OllamaModelInfo {
  capabilities: string[];
  /** The model runs on someone else's servers, though it's called through this Ollama. */
  remote: boolean;
}

export function showRequest(model: string): OllamaRequest {
  return { path: '/api/show', body: { model } };
}

export function parseShowReply(body: unknown): OllamaModelInfo {
  const show = body as { capabilities?: string[]; remote_host?: string; remote_model?: string } | null;
  return { capabilities: show?.capabilities ?? [], remote: Boolean(show?.remote_host || show?.remote_model) };
}
