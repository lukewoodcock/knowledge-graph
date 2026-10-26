# swarm-kg

A local AI agent swarm that builds a personal knowledge graph in your
**Obsidian** vault, powered by **Ollama** (local LLMs). POST your working
context from the IDE and the agents run automatically:

- **Documenter** — summarises what you're building into a structured note (`vault/code/`)
- **Researcher** — generates a best-practices/pitfalls note (`vault/research/`).
  Off by default; set `RESEARCHER_ENABLED=true` to turn it on
- **Linker** — connects new notes to existing ones with `[[wikilinks]]`

This is a TypeScript service — a migration of the original
[n8n-based implementation](https://github.com/lukewoodcock/utils) into plain
code for easier review, testing, and collaboration. **The webhook contract is
unchanged**: existing IDE integrations and curl commands work as-is.

```
IDE ──POST /webhook/knowledge-graph/trigger──►  swarm-kg service
                                                     │
                                              queue (one run at a time)
                                                     │
                                          ┌──────────┴──────────┐
                                          ▼                     ▼   (parallel)
                                     Documenter            Researcher (optional)
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
and `changed_code` are optional. So are `session_id` (the Claude Code session)
and `project` (the codebase, named after its git repository): when sent, they
are recorded as `session` and `project` in the frontmatter of every note the
run writes, and when left out those fields are simply absent.

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

Captures go through one in-process queue and run one at a time, in the order
they arrived, so several runs never compete for one local Ollama. A queued
run reports `"running"` until it has finished. The service's console logs one
line per finished run, with its id, status and how long the run took:

```
run 3f2c… complete in 23.4s (src/auth/jwt.py)
```

With the Researcher off (the default), a code capture writes only the
Documenter's note and `notes` has one entry; the run is still `"complete"`.

If one agent fails, the run degrades gracefully: `status` becomes `"partial"`,
the surviving note is still written and linked, and an `errors` array explains
what failed.

### Who can reach the service

There is no authentication, so the service listens on the loopback interface
(`127.0.0.1`) by default: only your own machine can send captures or read
notes. `HOST` changes the bind address. `docker compose` publishes the port
on the host's loopback only (`127.0.0.1:5678`), and sets `HOST=0.0.0.0` inside
the container so the published port can reach the service.

### Trigger from Claude Code (Stop hook)

`dist/hook/stop.js` is a Claude Code
[Stop hook](https://code.claude.com/docs/en/hooks#stop): at the end of each
Claude turn it reads the session transcript, finds the files Claude changed
since your last prompt (Edit / Write / MultiEdit / NotebookEdit calls that
succeeded), and POSTs **one trigger per changed file** to the webhook. Each
one has your prompt as `description`, `language` from the file extension,
and `changed_code` from `git diff HEAD -- <file>`, or from the tool input when
the file isn't tracked; both are capped at 4 KB. Every one also carries the
`session_id` Claude Code gave the hook and the `project`: the name of the git
repository the session's `cwd` is in (the main repository's name inside a
linked worktree), or the `cwd` folder's name outside one. A turn with no edits
sends nothing.

It never gets in Claude's way: nothing on stdout, always exit 0, a 2s
timeout per POST and a 5s hard deadline. It does nothing when
`stop_hook_active` is true, when `SWARM_KG_DISABLE=1`, or when the session's
`cwd` is inside `SWARM_KG_VAULT_PATH`, so Claude editing the vault can't
feed the graph its own notes.

Wire it into a demo project:

```bash
npm install && npm run build                 # in this repo, produces dist/hook/stop.js
mkdir -p /path/to/demo-project/.claude
cp examples/claude-settings.json /path/to/demo-project/.claude/settings.json
# then edit the two /ABSOLUTE/PATH/TO placeholders in that file
```

If the demo project already has a `.claude/settings.json`, merge the
`hooks.Stop` entry from [`examples/claude-settings.json`](examples/claude-settings.json)
into it instead. `async: true` means Claude doesn't wait for the hook at all.
Check it's loaded with `/hooks` in Claude Code.

Try it by hand without Claude:

```bash
echo '{"hook_event_name":"Stop","stop_hook_active":false,
       "cwd":"'"$PWD"'","transcript_path":"'"$PWD"'/tests/fixtures/stop-transcript.jsonl"}' \
  | SWARM_KG_DEBUG=1 node dist/hook/stop.js
# [swarm-kg hook] 202 /demo/app/src/auth/jwt.ts   (one line per file, on stderr)
```

| Variable | Default | Description |
|----------|---------|-------------|
| `SWARM_KG_URL` | `http://localhost:5678/webhook/knowledge-graph/trigger` | Webhook to POST to |
| `SWARM_KG_VAULT_PATH` | unset | Skip sessions whose `cwd` is inside this path, and edits to files in it |
| `SWARM_KG_DISABLE` | unset | `1` turns the hook off |
| `SWARM_KG_MAX_FILES` | `5` | Most triggers sent per turn |
| `SWARM_KG_TIMEOUT_MS` | `2000` | Per-POST timeout |
| `SWARM_KG_DEBUG` | unset | `1` logs what it did to stderr |

## Development

```bash
npm install
npm run dev          # hot-reload dev server (tsx watch)
npm run typecheck    # tsc --noEmit
npm test             # vitest — 82 tests, <1s, no Docker needed
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
├── agents/
│   ├── documenter.ts
│   ├── researcher.ts
│   └── linker.ts
└── hook/               # Claude Code Stop hook (dist/hook/stop.js)
    ├── stop.ts         # entrypoint: stdin → transcript → POSTs
    ├── transcript.ts   # pure: last turn's prompt + edits from the JSONL
    ├── payload.ts      # pure: config, skip rules, webhook payloads
    └── io.ts           # stdin, git diff, fetch (never throw)
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
| `RESEARCHER_ENABLED` | `false` | `true` also writes a research note for every code capture |
| `HOST` | `127.0.0.1` | Address the service listens on (compose sets `0.0.0.0` inside the container and publishes on loopback) |
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
