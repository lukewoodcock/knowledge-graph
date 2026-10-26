# swarm-kg

A personal knowledge graph that grows from your coding sessions and that agents in other sessions can read from.

## Writing to the graph

**Capture**:
Anything sent to the service to become part of the graph. Comes in two kinds: code capture and memo.
_Avoid_: Trigger, event, webhook call

**Code capture**:
A capture of one file Claude changed, with a description of the work; the agents write it up as notes.
_Avoid_: File capture, edit event

**Memo**:
A capture already written by the agent in the session, distilled from the conversation: a learning, decision, todo, snippet or conversation summary.
_Avoid_: Memory, manual note, journal entry

**Kind**:
What sort of memo it is (learning, decision, todo, snippet, conversation).
_Avoid_: Type, category

**Capture hook**:
The Claude Code hook that sends a code capture for each file Claude changed in a turn.
_Avoid_: Trigger hook, webhook

**Session**:
One Claude Code conversation. Captures from the same session are linked to each other.
_Avoid_: Conversation, chat, thread

**Project**:
The codebase a capture came from, named after its git repository. Every note records its project.
_Avoid_: Repo, workspace, codebase

**Run**:
The work the service does for one capture: writing notes and linking them into the graph.
_Avoid_: Job, task, swarm run

**Agent**:
One of the LLM roles inside a run (Documenter, Researcher, Linker).
_Avoid_: Worker, bot

**Source**:
Anything that writes notes into the vault: Claude Code sessions today, a dataset importer in a business setting.
_Avoid_: Input, feed, connector

## The graph

**Vault**:
The single folder of markdown files that holds the graph, shared across every project.
_Avoid_: Store, database, repo

**Note**:
One markdown file in the vault.
_Avoid_: Document, page, entry

**Link**:
A `[[wikilink]]` from one note to another.
_Avoid_: Edge, relation, reference

**Graph**:
The notes in the vault together with the links between them.
_Avoid_: Knowledge base, KB, index

**Session log**:
The daily note recording every capture received that day; never a link target.
_Avoid_: Log note, daily note

## Reading from the graph

**Recall**:
An agent in another session pulling relevant notes from the graph into its work.
_Avoid_: Query, lookup, retrieval

**Context injection**:
Recall done automatically: relevant notes are added to the agent's context without it asking.
_Avoid_: Auto-recall, prompt stuffing
