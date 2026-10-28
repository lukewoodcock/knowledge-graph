---
title: "Add an OpenAPI description for notes-api"
date: 2026-10-21
tags: [memo, todo]
related: []
source: "memo"
type: "memo"
kind: "todo"
project: "notes-api"
session: "c5d81a3f-2e6b-4f90-b7a4-9d0e6c2b1021"
status: "open"
files: ["src/app.js"]
---

In the notes-api project (a small Node.js REST API for notes), the three routes in `src/app.js` are only documented in the README.

## To do
Write `openapi.yaml` describing `POST /notes`, `GET /notes` and `GET /notes/{id}`, with the `400` and `413` error bodies, so the web client can generate its types from it.

## Where to start
The route table at the top of `src/app.js`.

## Related Notes
- [[2026-10-20_notes-api_src_app.js]]
