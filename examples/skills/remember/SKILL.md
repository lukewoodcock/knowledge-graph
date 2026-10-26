---
name: remember
description: Save what's worth keeping from this conversation into the swarm-kg knowledge graph as memos.
argument-hint: "[what to remember]"
disable-model-invocation: true
allowed-tools: Bash(node /ABSOLUTE/PATH/TO/swarm-kg/dist/remember.js *)
---

# Remember

Distil this conversation into **memos**: notes for the swarm-kg knowledge graph, written by you, that an agent in another session and another project will recall months from now. That reader has none of this conversation, so every memo is **self-contained**.

What to remember: $ARGUMENTS

## 1. Choose what to capture

- **"What to remember" above names something**: capture just that, usually as one memo.
- **It is empty**: capture everything worth keeping since the last memo saved in this conversation (a previous `/remember` report), or since the start if there is none. Write one memo per distinct thing: a decision and a todo are two memos, never one blended note.

Worth keeping: the reasoning that the code alone doesn't show. Done when you have a list of distinct things, each with a kind.

## 2. Choose each memo's kind

Choose it yourself, without asking:

| Kind | For | Body carries |
|------|-----|--------------|
| `decision` | A choice that was made | What was chosen, the alternatives rejected and why. When an ADR was written for it, the ADR's content in full |
| `todo` | Something left to do | What to do, why, and where to start |
| `learning` | Something found out: a gotcha, how a tool behaves, why a bug happened | The finding and the evidence for it |
| `snippet` | A script, command or query worth reusing | The code verbatim in a fenced block, what it's good for, and how to run it |
| `conversation` | A discussion worth keeping as a whole, when it fits none of the above | A summary: the question, the options weighed, where it landed |

## 3. Write each memo

- **title**: one line that states the thing itself ("Use write-through caching for the session cache", rather than "Caching decision").
- **body**: markdown. Open with a **context paragraph**: the project, the problem being worked on, and the files involved. Then the content for its kind. Name everything in full (the tool, the file, the option) so each sentence reads cold; give longer bodies `##` sections, since each section is searched on its own.
- **files**: optional list of the paths the memo concerns, relative to the project root.

Leave out credentials, tokens, API keys, passwords, private keys and personal data (people's names, email addresses, phone numbers, addresses) entirely. Where a command needs a secret, write a placeholder such as `$API_TOKEN`.

## 4. Send the memos

The memos travel through a file: Claude Code's Bash check blocks any command whose text holds a brace followed by a quote, which memo JSON always does.

1. With the Write tool, write all the memos as one JSON array (at most 20) to `swarm-kg-memos.json` in your **scratchpad directory**, where writes need no approval and the capture hook never looks; without a scratchpad, use a temporary file. Valid JSON: escape `"` and `\` inside strings, and write line breaks as `\n`.

   ```json
   [{"kind": "decision", "title": "...", "body": "...", "files": ["src/cache.ts"]}]
   ```

2. Send them with **one** Bash call of exactly this shape:

   ```bash
   node /ABSOLUTE/PATH/TO/swarm-kg/dist/remember.js --session "${CLAUDE_SESSION_ID}" --project-dir "${CLAUDE_PROJECT_DIR}" < /path/to/scratchpad/swarm-kg-memos.json
   ```

The command adds the session and the project itself. Its exit code says what happened:

- **0**: saved. The output lists each memo's name, kind and links.
- **1**: nothing was saved, and the output says why. For a rejected field, fix the memos and send them again; for a service that isn't running, tell the user.
- **2**: accepted but still queued when the command stopped waiting. Run the `--run` command it printed once more.

## 5. Report back

Tell the user what was saved: for each memo, its name, its kind and the notes it links to, from the command's output. Say so when a memo has no links, and pass on any partial-run warning as printed.
