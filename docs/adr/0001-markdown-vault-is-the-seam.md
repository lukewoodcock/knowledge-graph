# The markdown vault is the seam between sources and recall

Every source writes plain markdown notes with `[[links]]` into one vault, and recall only ever reads notes: it knows nothing about where they came from. We chose this over a database so the graph stays human-readable and editable in Obsidian, and so a new source (for example a business dataset importer) is just another note writer, with no change to the read side. Search embeddings live in an index file inside the vault that can be deleted and rebuilt from the notes at any time, so the notes stay the only source of truth.

## Considered Options

- **A graph or vector database as the store.** Faster at scale, but notes stop being browsable files and every source has to learn its schema. That isn't worth it at the size of a personal vault (hundreds to low thousands of notes).
