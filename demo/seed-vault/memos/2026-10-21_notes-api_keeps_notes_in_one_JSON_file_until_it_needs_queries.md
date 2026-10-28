---
title: "notes-api keeps notes in one JSON file until it needs queries"
date: 2026-10-21
tags: [memo, conversation]
related: []
source: "memo"
type: "memo"
kind: "conversation"
project: "notes-api"
session: "c5d81a3f-2e6b-4f90-b7a4-9d0e6c2b1021"
files: ["src/store.js"]
---

In the notes-api project (a small Node.js REST API for notes), we discussed how `src/store.js` should persist notes.

## Question
SQLite, or a single JSON file?

## Options weighed
- **SQLite** (`better-sqlite3`): real queries and safe concurrent writes, but a native dependency to build on every machine.
- **One JSON file**, rewritten on every change through a temporary file and a rename, so a crash never leaves half a file.

## Where it landed
The JSON file, while the API only lists and reads notes by id. Move to SQLite when search or filtering arrives; the store's `list`, `get` and `create` functions are the only seam to change.

## Related Notes
- [[2026-10-20_notes-api_src_app.js]]
- [[2026-10-21_Check_the_notes-api_data_file_with_jq]]
