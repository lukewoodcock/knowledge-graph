export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Extracts assistant text from an LLM response, supporting both the native
 * Ollama format ({message: {content}}) and the OpenAI-compatible format
 * ({choices: [{message: {content}}]}). Returns '' if neither is present.
 */
export function extractContent(response: unknown): string {
  const r = response as {
    message?: { content?: string };
    choices?: Array<{ message?: { content?: string } }>;
  };
  return r?.message?.content ?? r?.choices?.[0]?.message?.content ?? '';
}

/**
 * Sends a chat completion request to Ollama and returns the assistant text.
 * Throws on non-2xx responses so callers can decide how to degrade.
 * `think` is sent explicitly: Ollama ignores it for non-thinking models.
 */
export async function chat(
  baseUrl: string,
  model: string,
  messages: ChatMessage[],
  think = false,
): Promise<string> {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: false, think, messages }),
  });

  if (!res.ok) {
    throw new Error(`Ollama request failed: HTTP ${res.status} ${res.statusText}`);
  }

  return extractContent(await res.json());
}
