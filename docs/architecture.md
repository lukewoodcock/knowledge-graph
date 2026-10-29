# Architecture

knowledge-graph turns Claude Code sessions into a graph of linked markdown notes, and
lets an agent in any other session recall them. Everything runs on one
machine: Ollama, the service, the vault, the hooks and the MCP server.

```mermaid
flowchart LR
  subgraph A["Session A, project A"]
    CH["Capture hook<br/>Stop, async"]
    RM["/remember skill<br/>the session's agent<br/>writes memos"]
  end

  subgraph W["knowledge-graph service, 127.0.0.1 only: runs"]
    Q["Capture queue<br/>one run at a time"]
    DOC["Documenter"]
    RES["Researcher<br/>off by default"]
    MEMO["Memo notes, linked<br/>to same-session code<br/>notes and each other<br/>by rule"]
    LNK["Linker<br/>picks from the 10<br/>most similar notes"]
  end

  subgraph V["Vault: markdown, open in Obsidian"]
    N["Notes and links<br/>code/ memos/ research/<br/>session log"]
    I[".knowledge-graph/index.json<br/>each section embedded<br/>with a context prefix;<br/>rebuildable"]
  end

  subgraph R["knowledge-graph service: read API"]
    API["search, note, related"]
  end

  subgraph B["Session B, project B"]
    MCP["MCP server, stdio<br/>search_notes, get_note,<br/>related_notes,<br/>guided by /recall"]
    CI["Context-injection hook<br/>UserPromptSubmit, sync"]
    AG["Agent answers,<br/>citing the notes"]
  end

  RD["Reader: npm run ask<br/>tool loop on a local<br/>Ollama model"]

  CH -- "code capture" --> Q
  RM -- "memos" --> Q
  Q --> DOC & RES
  Q --> MEMO
  DOC & RES & MEMO --> LNK
  LNK -- "write" --> N
  N -- "embed after the run" --> I
  I & N --> API
  API -- "tool calls" --> MCP & RD
  API -- "score ≥ 0.6, best 3,<br/>≤ 4,000 chars" --> CI
  MCP -- "agent chooses<br/>to recall" --> AG
  CI -- "reference-notes<br/>block on every prompt" --> AG
```

**Two write paths.** The capture hook sends one code capture per file Claude
changed in a turn; the run's agents (Documenter, optionally Researcher, then
Linker) write it up as notes. A memo is written by the agent in the session
itself (a learning, decision, todo, snippet or conversation), so it carries
the reasoning, not just the diff; its run skips straight to linking.

**Three read paths.** Recall over MCP is the agent choosing to search, open a
note and walk its links. Context injection is recall done for it: every
prompt is searched and the few notes that clear the threshold are added.
The Reader (`npm run ask`) is recall with no cloud model at all: a small
tool loop on a local Ollama model, with the MCP server's three tools, for
notes that must never leave the machine.

## Trade-offs

| Decision | Chosen | Rejected | Why |
|----------|--------|----------|-----|
| Vault | Markdown vault as the seam ([ADR 0001](adr/0001-markdown-vault-is-the-seam.md)) | Graph or vector database | Notes stay readable and editable in Obsidian; a new source is just another note writer |
| Index | One rebuildable file in the vault, brute-force cosine | Vector database | Notes stay the only source of truth; a personal vault is hundreds to low thousands of notes |
| Chunks | Each `##` section embedded with title, type, kind, project and summary in front; a note scores as its best section | Whole-note embeddings | Long notes would be cut at the model's input limit, and "Key Points" alone matches nothing |
| Runs | One in-process queue, one run at a time | Parallel runs, a message broker | Parallel runs fight over one local Ollama and fail; a broker is overkill on one machine |
| Researcher | Off by default | Always on | The graph should hold my knowledge, not generic advice, and runs take about half the time |
| Who writes memos | The agent in the session | Ollama summarising the transcript | It has the whole conversation and is the strongest model available |
| Links | Same Session links by rule; the Linker chooses from the 10 most similar notes | The Linker reading every note name | Session links are certain, not guessed; candidates keep the Linker fast and accurate as the vault grows |
| Recall interface | stdio MCP server, a thin client of the service | An HTTP MCP server; agents reading vault files directly | No second network listener; the service stays the only owner of the index |
| Context injection | Synchronous hook, gives up after 1.5 s, off unless a project adds it | Async hook, on everywhere | Async context arrives one prompt late; extra tokens and invisible recall aren't worth it everywhere ([pros and cons](../examples/README.md#should-you-turn-it-on-for-a-project)) |
| Search | Embeddings only | Keyword or hybrid search | Enough for the POC; hybrid can come later |
| Local recall | The Reader: a small tool loop over Ollama's `/api/chat` ([ADR 0002](adr/0002-local-recall-is-a-small-purpose-built-loop.md)) | Claude Code pointed at Ollama | Claude Code's large prompt took 158 s on a local model and skipped the graph tools; the loop answers in about 14 s |

## Safety

- **Loopback only.** There is no authentication, so the service binds to
  `127.0.0.1` by default and compose publishes its port, and Ollama's, on
  loopback only (with `docker run`, `-p 127.0.0.1:5678:5678`): nobody on the
  same wifi can send captures, read notes or use the models. The MCP server
  speaks stdio and has no listener at all. The Reader refuses to start unless
  Ollama and the service are on loopback and the model is not an Ollama cloud
  model, so nothing it reads leaves the machine.
- **Recalled notes are data, not instructions.** Notes can hold text from
  any captured file. Every MCP tool description, the Reader's system prompt and the `/recall` skill say so, and context
  injection wraps notes in a `<knowledge-graph-reference-notes>` block that tells the
  agent not to follow them, with any copy of that tag inside a note escaped.
- **A size cap on recalled text.** Context injection adds at most three notes
  and 4,000 characters per prompt, never more than 9,000. Opening a note
  (`get_note`) returns at most 20,000 characters of it (`NOTE_MAX_CHARS`),
  ending with a `[truncated: ...]` marker when it was cut.
- **No secrets in memos.** `/remember` leaves out credentials, tokens and
  personal data entirely; keeping them would need an encrypted vault and an
  authenticated service first.
- **The graph can't feed on itself.** The capture hook skips sessions working
  inside the vault, and every hook fails silent: always exit 0, short
  timeouts, nothing added if the service is down.

## Left out on purpose

Summarising across many notes for broad questions, automatic capture before `/compact`, secrets
in memos and a dataset source are in [docs/ideas.md](ideas.md). Also out:
authentication, running anywhere but my machine, keyword search, and making
it installable by others. The read side was built so a second source needs
no change to it ([ADR 0001](adr/0001-markdown-vault-is-the-seam.md)).

## Where the build differs from the spec

- The capture hook only captures files inside the session's project (the top
  of its git repository), not every file Claude changes: Claude also edits
  files elsewhere, such as its own memory files under `~/.claude/projects/`,
  and those aren't the project's code. Files in the vault or the session's
  scratchpad are skipped too.
- Code-capture notes are named `<date>_<project>_<file path>`, so two projects
  changing a same-named file on one day get a note each.
- Search results carry the note's `type` (`code`, `memo`) and, for memos
  only, its `kind`, rather than one kind field for both, plus its `status`.
  Search filters by all three, so "open todos" is `kind: todo, status: open`.
- Research notes are left out of recall by their own `type: research`,
  wherever they live, so the read side knows nothing about the Researcher's
  folder.
- Sections over about 1,500 characters are split again at paragraph breaks,
  keeping their heading; session logs are left out of search as well as linking.
- Same Session links go to the session's code-capture notes and to the other
  memos sent in the same request, never to memos from earlier requests. The
  Linker never offers a note the new note already links to, so it never
  repeats a Same Session link.
- Opening a note returns at most `NOTE_MAX_CHARS` (20,000) characters of it,
  the cap on recalled text covering `get_note` as well as context injection.
- Context injection skips prompts starting with `/`, so `/recall` does its
  own recall. The 0.6 threshold was measured with `bge-large`.
- `/remember` and `/recall` ship as example skills with the MCP config.
  `/remember` sends its memos through a file in the session's scratchpad and
  a small command (`dist/remember.js`) rather than an inline `curl`: Claude
  Code's Bash check refuses command text with a brace followed by a quote,
  which memo JSON always has. The capture hook skips scratchpad files, so that
  file is never a code capture.
