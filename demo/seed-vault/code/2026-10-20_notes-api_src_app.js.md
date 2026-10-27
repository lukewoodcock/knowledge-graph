---
title: "notes-api HTTP server: create, list and read notes"
date: 2026-10-20
tags: [javascript, nodejs, http, rest]
related: []
source: "ide-webhook"
type: "code"
project: "notes-api"
session: "7a2c5e91-8d4f-4c3b-a6e7-0f9b2d4c1020"
---

## Summary
`src/app.js` serves the notes-api on Node's built-in `http` module: `POST /notes` creates a note from `{"title", "body"}`, `GET /notes` lists them newest first, and `GET /notes/<id>` returns one. Notes are kept by `src/store.js` in a JSON file.

## Key Points
- Request bodies over 64 KB are refused with `413`.
- A missing title is a `400` naming the field.
- `PORT` sets the port, 4000 by default; `NOTES_FILE` sets the data file, `data/notes.json` by default.

## Notes
`POST /notes` has no protection against a client creating notes in a loop.

## Related Notes
- [[2026-10-21_notes-api_keeps_notes_in_one_JSON_file_until_it_needs_queries]]
