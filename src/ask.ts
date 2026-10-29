/**
 * dist/ask.js, run as `npm run ask -- "question"`: answers a recall question
 * from the graph with the Reader, on a local Ollama model. The answer and the
 * notes it used go to stdout; progress and errors go to stderr.
 *
 * Exit codes: 0 answered, 1 could not answer, 2 no question.
 */
import { positiveInt, serviceUrl } from './env';
import { ReaderAnswer, ReaderError, ReaderStep, ask, DEFAULT_MAX_STEPS, DEFAULT_OLLAMA_TIMEOUT_MS } from './reader';

/** Ollama's own default address, on loopback. */
const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

/** A mixture-of-experts model (3B active): fast and accurate enough on the demo question. */
const DEFAULT_MODEL = 'qwen3.6:35b-a3b-coding';

/** The answer, then the notes it drew on, as the /recall skill's answers end. */
export function formatAnswer(result: ReaderAnswer): string {
  const lines = [result.answer, '', '**Notes used**'];
  if (result.notes.length === 0) lines.push('- none cited');
  for (const n of result.notes) lines.push(`- [[${n.name}]]${n.project ? ` (${n.project})` : ''}`);
  if (result.unverified.length > 0) {
    lines.push('', `**Cited but never retrieved** (check these): ${result.unverified.map(n => `[[${n}]]`).join(', ')}`);
  }
  return lines.join('\n') + '\n';
}

function formatStep(s: ReaderStep): string {
  const what =
    s.toolCalls.length === 0 ? 'answer' : s.toolCalls.map(c => `${c.name} ${JSON.stringify(c.arguments)}`).join(', ');
  return `step ${s.step} (${(s.ms / 1000).toFixed(1)} s): ${what}`;
}

async function main(): Promise<number> {
  const question = process.argv.slice(2).join(' ').trim();
  if (!question) {
    console.error('usage: npm run ask -- "question"   (or: node dist/ask.js "question")');
    return 2;
  }

  const env = process.env;
  const model = env.SWARM_KG_READER_MODEL || DEFAULT_MODEL;
  const started = Date.now();
  let steps = 0;
  console.error(`ask: ${model} on ${env.SWARM_KG_READER_OLLAMA_URL || DEFAULT_OLLAMA_URL}`);
  try {
    const result = await ask(question, {
      serviceUrl: serviceUrl(env),
      ollamaUrl: (env.SWARM_KG_READER_OLLAMA_URL || DEFAULT_OLLAMA_URL).replace(/\/+$/, ''),
      model,
      maxSteps: positiveInt(env.SWARM_KG_READER_MAX_STEPS, DEFAULT_MAX_STEPS),
      ollamaTimeoutMs: positiveInt(env.SWARM_KG_READER_TIMEOUT_MS, DEFAULT_OLLAMA_TIMEOUT_MS),
      onStep: s => {
        steps = s.step;
        console.error(formatStep(s));
      },
    });
    console.error(`answered in ${((Date.now() - started) / 1000).toFixed(1)} s, ${steps} steps`);
    process.stdout.write(formatAnswer(result));
    return 0;
  } catch (err) {
    console.error(`ask: ${err instanceof ReaderError ? err.message : String(err)}`);
    return 1;
  }
}

if (require.main === module) {
  main().then(code => (process.exitCode = code));
}
