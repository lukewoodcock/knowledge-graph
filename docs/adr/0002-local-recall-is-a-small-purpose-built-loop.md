# Local recall is a small purpose-built loop, not Claude Code on Ollama

Recall answered in the session goes through Claude in the cloud, so the notes it reads leave the machine. For sensitive notes, the Reader (`npm run ask`) answers recall questions with a local Ollama model: a small loop over Ollama's native `/api/chat` with tool calls, a short system prompt, and the MCP server's three tools (`search_notes`, `get_note`, `related_notes`) from one shared definition. It refuses a non-loopback Ollama or service URL and an Ollama cloud model, with no override, so "local" can't be configured away by accident. On an M4 Pro with 48 GB, `qwen3.6:35b-a3b-coding` (a mixture-of-experts model, 3B active) answers the demo question correctly with citations in about 14 s with the model loaded.

## Considered Options

- **Claude Code pointed at Ollama's Anthropic-compatible API.** It keeps `/recall` and the MCP server as they are, but its system prompt and tool definitions run to tens of thousands of tokens, which a local model reads slowly. With the same 35B model it took 158 s, never loaded `/recall` or called the graph tools, and gave a partly wrong answer.
- **Another ready-made harness through `ollama launch`** (OpenCode, Qwen Code). Same trade: a large general-purpose prompt and tools the model has to choose among, on hardware where every prompt token costs.
- **Ollama's desktop chat.** It has no way to give the model our tools, so it can't read the graph.
- **An override for a remote Ollama on the LAN.** Rejected: the point is that notes never leave the machine, and a setting that silently breaks that is worse than none.
