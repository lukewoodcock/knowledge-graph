# Example Claude Code settings

Copy or merge these into a project's `.claude/settings.json`, then replace the
`/ABSOLUTE/PATH/TO` placeholders. Build this repo first (`npm run build`) so
`dist/hook/` exists. Check what's loaded with `/hooks` in Claude Code.

| File | Hook | What it does |
|------|------|--------------|
| [`claude-settings.json`](claude-settings.json) | `Stop` | The capture hook: sends a code capture for each file Claude changed in a turn |
| [`claude-settings.context-injection.json`](claude-settings.context-injection.json) | `UserPromptSubmit` | Context injection: adds the most relevant notes from the graph to every prompt |

Both hooks can live in one settings file: merge the `hooks.UserPromptSubmit`
entry next to `hooks.Stop`.

## Context injection

Off unless you add its entry to a project's settings, and switched off again by
removing it (or with `SWARM_KG_DISABLE=1`). On every prompt it searches the
graph with the prompt and, when notes score at least `SWARM_KG_MIN_SCORE`, adds
the best three as additional context, in a `<swarm-kg-reference-notes>` block
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
`"command": "SWARM_KG_MIN_SCORE=0.65 node /ABSOLUTE/PATH/TO/swarm-kg/dist/hook/prompt.js"`.

| Variable | Default | Description |
|----------|---------|-------------|
| `SWARM_KG_SEARCH_URL` | `http://localhost:5678/webhook/knowledge-graph/search` | The service's search endpoint |
| `SWARM_KG_MIN_SCORE` | `0.6` | Relevance threshold: notes scoring below it are left out |
| `SWARM_KG_MAX_NOTES` | `3` | Most notes added to one prompt |
| `SWARM_KG_MAX_CONTEXT_CHARS` | `4000` | Most characters added, wrapper included; never more than 9,000, as Claude Code moves context over 10,000 characters to a file |
| `SWARM_KG_SEARCH_TIMEOUT_MS` | `1500` | How long to wait for the search before adding nothing |
| `SWARM_KG_DISABLE` | unset | `1` turns the hook off |
| `SWARM_KG_DEBUG` | unset | `1` logs what it did to stderr |

The default threshold was measured with `bge-large` against ten typical code
notes: for prompts about something in the graph the right note scored 0.63 to
0.81, while unrelated prompts ("fix the typo in the README", "thanks, looks
good") never scored above 0.51. Raise it if unrelated notes show up, lower it
if relevant ones don't; with another embedding model, measure again.
