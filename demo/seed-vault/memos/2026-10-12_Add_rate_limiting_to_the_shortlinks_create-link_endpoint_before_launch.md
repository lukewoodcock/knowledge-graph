---
title: "Add rate limiting to the shortlinks create-link endpoint before launch"
date: 2026-10-12
tags: [memo, todo]
related: []
source: "memo"
type: "memo"
kind: "todo"
project: "shortlinks"
session: "3d8e1f60-2b7c-4a95-9e04-6c1b5a7d1012"
status: "open"
files: ["src/server.js"]
---

In the shortlinks project (a small dependency-free Node.js URL shortener), `POST /links` in `src/server.js` accepts any number of requests, and short codes come from a counter, so one client can fill the store or enumerate codes.

## To do
Rate-limit `POST /links` per client before launch, answering `429 Too Many Requests` with a `Retry-After` header when a client is over the limit. Keep it dependency-free, like the rest of the project.

## Where to start
`src/server.js`, in the `POST /links` handler, before the URL is stored.

## Same Session
- [[2026-10-12_src_server.js]]
- [[2026-10-12_src_codes.js]]

## Related Notes
- [[2026-10-12_Short_codes_are_the_base62_encoding_of_an_auto-increment_counter]]
