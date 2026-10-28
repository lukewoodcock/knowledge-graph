---
title: "Short codes are the base62 encoding of an auto-increment counter"
date: 2026-10-12
tags: [memo, decision]
related: []
source: "memo"
type: "memo"
kind: "decision"
project: "shortlinks"
session: "3d8e1f60-2b7c-4a95-9e04-6c1b5a7d1012"
files: ["src/codes.js", "src/server.js"]
---

In the shortlinks project (a small dependency-free Node.js URL shortener), we needed a way to turn a long URL into a short code for `POST /links`. The code lives in `src/codes.js`, used by `src/server.js`.

## Decision
Each new link takes the next value of a counter, and its short code is that number in base62. Codes stay as short as possible and can never collide.

## Alternatives rejected
- **Hashing the URL** (first characters of a SHA-256): collisions need checking and retrying, and codes are longer for the same number of links.
- **Random UUIDs**: 36 characters, too long for a short link.

## Consequence
Codes are sequential and guessable, so anyone can enumerate every link. Rate limiting the create endpoint is the first defence; see the todo.

## Same Session
- [[2026-10-12_shortlinks_src_codes.js]]
- [[2026-10-12_shortlinks_src_server.js]]

## Related Notes
- [[2026-10-12_Add_rate_limiting_to_the_shortlinks_create-link_endpoint_before_launch]]
