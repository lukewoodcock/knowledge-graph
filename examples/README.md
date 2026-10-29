# Example Claude Code settings

Copy or merge these into a project's `.claude/settings.json`, then replace the
`/ABSOLUTE/PATH/TO` placeholders. Build this repo first (`npm run build`) so
`dist/hook/` exists. Check what's loaded with `/hooks` in Claude Code.

| File | Hook | What it does |
|------|------|--------------|
| [`claude-settings.json`](claude-settings.json) | `Stop` | The capture hook: sends a code capture for each file Claude changed in a turn. Also pre-approves the `/recall` skill and the three recall tools, and enables the MCP server |
| [`claude-settings.context-injection.json`](claude-settings.context-injection.json) | `UserPromptSubmit` | Context injection: adds the most relevant notes from the graph to every prompt |

Both hooks can live in one settings file: merge the `hooks.UserPromptSubmit`
entry next to `hooks.Stop`.

Recall and memos need a few more files, which go elsewhere in the project
(see the main README, "Wire recall into a project" and "Save memos from Claude
Code"):

| File | Copy to | What it does |
|------|---------|--------------|
| [`mcp.json`](mcp.json) | `<project>/.mcp.json` | The `knowledge-graph` MCP server: `search_notes`, `get_note`, `related_notes` |
| [`skills/recall/`](skills/recall/SKILL.md) | `<project>/.claude/skills/recall/` | The `/recall` skill |
| [`skills/remember/`](skills/remember/SKILL.md) | `<project>/.claude/skills/remember/` | The `/remember` skill: the agent in the session writes memos from the conversation and saves them to the graph |

## /remember

```bash
mkdir -p /path/to/demo-project/.claude/skills
cp -R examples/skills/remember /path/to/demo-project/.claude/skills/remember
# then edit both /ABSOLUTE/PATH/TO placeholders in its SKILL.md:
# the allowed-tools line and the command in step 4
```

Only you can run it (`disable-model-invocation`), since it writes to the vault.
With no argument, the agent saves everything worth keeping since the last
memo, one memo per distinct thing; with an argument (`/remember the deploy
script`), just that. It writes the memos to a file in its scratchpad and sends
them with `node dist/remember.js`, which the skill's `allowed-tools`
pre-approves, so saving needs no permission prompt. The service must be
running; set `KG_SERVICE_URL` in the environment Claude Code starts in
if it isn't on `http://127.0.0.1:5678`. See the
[README](../README.md#save-memos-from-claude-code-remember) for how it works.

## Context injection

Off unless you add its entry to a project's settings, and switched off again by
removing it (or with `KG_DISABLE=1`). On every prompt it searches the
graph with the prompt and, when notes score at least `KG_MIN_SCORE`, adds
the best three as additional context, in a `<knowledge-graph-reference-notes>` block
that names each note and tells Claude they are reference material, not
instructions. Prompts starting with `/` (such as `/recall ...`) are skipped.

The entry is deliberately not `async`: an async hook's context only arrives on
the next prompt. Instead the hook gives up on the search after 1.5 s and adds
nothing, so a down or slow service never holds the prompt back; `"timeout": 5`
is only a backstop.

### Should you turn it on for a project?

For:

- Recall happens without the agent having to think of it, or you having to ask
  with `/recall`.
- Answers improve when past work is relevant: decisions, pitfalls and code from
  other sessions and other projects are already in view.
- It costs nothing when nothing is relevant: below the threshold it adds no
  text at all.

Against:

- Every prompt pays for a search (tens of milliseconds warm, about a second when
  the embedding model has to load) and, when notes match, up to 4,000 extra
  characters of context.
- Irrelevant or outdated notes can mislead. The threshold keeps most out, but a
  note can clear it and still be about something else.
- The agent's use of the graph becomes invisible: the notes arrive as a system
  reminder, not as a tool call you can see in the transcript.

A good fit is a project where past sessions keep coming up (a codebase you
return to, related projects sharing ideas). Leave it off for one-off or
unrelated work, and rely on the `/recall` skill there.

### Settings

Set them in front of the command, for example
`"command": "KG_MIN_SCORE=0.65 node /ABSOLUTE/PATH/TO/knowledge-graph/dist/hook/prompt.js"`.

| Variable | Default | Description |
|----------|---------|-------------|
| `KG_SERVICE_URL` | `http://127.0.0.1:5678` | The service, as for the MCP server; the hook calls its `/webhook/knowledge-graph/search` |
| `KG_MIN_SCORE` | `0.6` | Relevance threshold: notes scoring below it are left out |
| `KG_MAX_NOTES` | `3` | Most notes added to one prompt |
| `KG_MAX_CONTEXT_CHARS` | `4000` | Most characters added, wrapper included; never more than 9,000, as Claude Code moves context over 10,000 characters to a file |
| `KG_SEARCH_TIMEOUT_MS` | `1500` | How long to wait for the search before adding nothing |
| `KG_DISABLE` | unset | `1` turns the hook off |
| `KG_DEBUG` | unset | `1` logs what it did to stderr |

The default threshold was measured with `bge-large` against ten typical code
notes: for prompts about something in the graph the right note scored 0.63 to
0.81, while unrelated prompts ("fix the typo in the README", "thanks, looks
good") never scored above 0.51. Raise it if unrelated notes show up, lower it
if relevant ones don't; with another embedding model, measure again.
