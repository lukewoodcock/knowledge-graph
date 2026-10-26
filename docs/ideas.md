# Ideas (out of scope for the POC)

- **A reader agent.** Today recall hands notes to the agent in the session, which reads them and answers. A dedicated agent loop for reading the graph (its own skills, multi-step search, following links, summarising across notes) could give better answers to broad questions. Out of scope for the POC.
- **Automatic conversation capture.** A `PreCompact` hook that writes memos from the conversation before `/compact` throws the detail away. It needs something to write them without being asked: the slow Ollama route over the transcript, or a headless Claude call. `/remember` proves the value first.
- **Secrets in memos.** Memos leave out credentials, tokens and personal data entirely. Keeping them would need the vault encrypted and the service authenticated first.
- **A dataset source.** In a business setting the vault could be filled from a dataset (tickets, docs, wiki pages) by an importer that writes notes. Recall wouldn't need to change (see ADR 0001).
