# swarm-kg

A local AI agent swarm that builds a personal knowledge graph in your
**Obsidian** vault, powered by **Ollama** (local LLMs). POST your working
context from the IDE and three agents run automatically:

- **Documenter** — summarises what you're building into a structured note (`vault/code/`)
- **Researcher** — generates a best-practices/pitfalls note (`vault/research/`)
- **Linker** — connects new notes to existing ones with `[[wikilinks]]`

This is a TypeScript service — a migration of the original
[n8n-based implementation](https://github.com/lukewoodcock/utils) into plain
code for easier review, testing, and collaboration. **The webhook contract is
unchanged**: existing IDE integrations and curl commands work as-is.

```
IDE ──POST /webhook/knowledge-graph/trigger──►  swarm-kg service
                                                     │
                                          ┌──────────┴──────────┐
                                          ▼                     ▼   (parallel)
                                     Documenter            Researcher
                                          └──────────┬──────────┘
                                                     ▼
                                                  Linker
                                                     │
                                              Obsidian Vault
```

## Quick start

```bash
cp .env.example .env        # set VAULT_HOST_PATH to your vault
docker compose up -d --build
docker exec -it ollama ollama pull qwen3.5:9b
```

Podman on macOS works identically: `podman compose up -d --build`.

### Trigger from the IDE

```bash
curl -s -X POST http://localhost:5678/webhook/knowledge-graph/trigger \
  -H "Content-Type: application/json" \
  -d '{
    "file_path":    "src/auth/jwt.py",
    "language":     "python",
    "description":  "Implemented JWT token refresh with sliding expiry window",
    "changed_code": "def refresh_token(user_id, token): ..."
  }' | jq .
```

Payload: at least one of `file_path` / `description` is required; `language`
and `changed_code` are optional.

The service replies `202 Accepted` straight away and the agents run in the
background:

```json
{ "status": "accepted", "run_id": "3f2c…", "status_url": "/webhook/knowledge-graph/runs/3f2c…" }
```

Poll the status URL. It returns `{"status": "running"}` until the run finishes,
then the full result:

```bash
curl -s http://localhost:5678/webhook/knowledge-graph/runs/3f2c… | jq .
```

```json
{
  "run_id": "3f2c…",
  "status": "complete",
  "session_date": "2026-06-10",
  "file_path": "src/auth/jwt.py",
  "language": "python",
  "notes": [
    { "agent": "documenter", "note_path": "/vault/code/2026-06-10_src_auth_jwt.py.md", "title": "src_auth_jwt.py" },
    { "agent": "researcher", "note_path": "/vault/research/2026-06-10_research_Implemented_JWT....md", "title": "..." }
  ],
  "linker": { "status": "success", "links_written": 1 }
}
```

Run status is kept in memory (last 100 runs), so it's lost on restart.

If one agent fails, the run degrades gracefully: `status` becomes `"partial"`,
the surviving note is still written and linked, and an `errors` array explains
what failed.

## Development

```bash
npm install
npm run dev          # hot-reload dev server (tsx watch)
npm run typecheck    # tsc --noEmit
npm test             # vitest — 44 tests, <1s, no Docker needed
npm run build        # compile to dist/
```

### Project layout

```
src/
├── index.ts            # entrypoint
├── server.ts           # Express app: webhook + orchestration (replaces n8n Orchestrator)
├── config.ts           # env var loading
├── ollama.ts           # /api/chat client + response parsing
├── vault.ts            # safeTitle, frontmatter, file helpers
└── agents/
    ├── documenter.ts
    ├── researcher.ts
    └── linker.ts
tests/                  # vitest unit + in-process end-to-end tests
```

### Tests

All tests run in-process with no Docker — the end-to-end suite spins up a mock
Ollama HTTP server and a temp-dir vault, exercising the real Express app, real
agent code, and real filesystem writes. CI (`.github/workflows/tests.yml`)
runs typecheck, tests, and a production build on every PR.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VAULT_HOST_PATH` | `./vault` | Host path to your Obsidian vault (compose only) |
| `VAULT_PATH` | `/vault` | Vault path inside the container |
| `OLLAMA_URL` | `http://ollama:11434` | Ollama API base URL |
| `OLLAMA_MODEL` | `qwen3.5:9b` | Model for all agents (`qwen2.5-coder:7b`, `llama3.2`, ...) |
| `OLLAMA_THINK` | `false` | Let thinking models reason first. ~20x slower on a 9B model |
| `PORT` | `5678` | Webhook service port |

## Changes from the n8n version

Behaviour-preserving migration, with a few deliberate fixes:

- **Session log appends** instead of overwriting — multiple triggers per day
  accumulate entries under one frontmatter header.
- **Partial failure handling** — one agent failing no longer aborts the run
  (`Promise.allSettled`).
- **Linker path safety** — the linker only writes to notes it just created,
  so a hallucinated path from the LLM can never touch other files.
- **No URL string-replace hack** — agents are function calls, not HTTP
  round-trips through the workflow engine.
