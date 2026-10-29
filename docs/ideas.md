# Ideas (out of scope for the POC)

- **A reader that summarises across notes.** The Reader (`npm run ask`, [ADR 0002](adr/0002-local-recall-is-a-small-purpose-built-loop.md)) now answers recall questions with a local model: multi-step search, opening notes, following links. Still out of scope: its own skills, and answers to broad questions ("what did I learn about rate limiting this year?") that need more notes than one context holds, summarised in stages.
- **Automatic conversation capture.** A `PreCompact` hook that writes memos from the conversation before `/compact` throws the detail away. It needs something to write them without being asked: the slow Ollama route over the transcript, or a headless Claude call. `/remember` proves the value first.
- **Secrets in memos.** Memos leave out credentials, tokens and personal data entirely. Keeping them would need the vault encrypted and the service authenticated first.
- **A dataset source.** In a business setting the vault could be filled from a dataset (tickets, docs, wiki pages) by an importer that writes notes. Recall wouldn't need to change (see ADR 0001).
