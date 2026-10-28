---
title: "Check the notes-api data file with jq"
date: 2026-10-21
tags: [memo, snippet]
related: []
source: "memo"
type: "memo"
kind: "snippet"
project: "notes-api"
session: "c5d81a3f-2e6b-4f90-b7a4-9d0e6c2b1021"
files: ["data/notes.json"]
---

In the notes-api project, notes are stored in one JSON file (`data/notes.json`), and a hand edit or a crash mid-write could leave it invalid.

## Snippet
```bash
# Exit code 0 and a count if the file is valid JSON; an error with a line number if not
jq 'length' data/notes.json

# The five newest notes' ids and titles
jq -r 'sort_by(.createdAt) | reverse | .[:5][] | "\(.id)\t\(.title)"' data/notes.json
```

## What it's good for
A quick check after editing the data file by hand, or before restarting the API after a crash.

## Related Notes
- [[2026-10-21_notes-api_keeps_notes_in_one_JSON_file_until_it_needs_queries]]
