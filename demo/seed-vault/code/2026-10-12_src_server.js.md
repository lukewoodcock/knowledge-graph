---
title: "shortlinks HTTP server: create and follow short links"
date: 2026-10-12
tags: [javascript, nodejs, http, url-shortener]
related: []
source: "ide-webhook"
type: "code"
project: "shortlinks"
session: "3d8e1f60-2b7c-4a95-9e04-6c1b5a7d1012"
---

## Summary
`src/server.js` is the whole shortlinks service on Node's built-in `http` module, with no dependencies. `POST /links` with `{"url": "..."}` stores the URL under the next counter value and returns its short code; `GET /<code>` redirects to the stored URL with a `302`.

## Key Points
- Links live in an in-memory `Map` from counter to URL; restarting the server forgets them.
- Only `http:` and `https:` URLs are accepted; anything else is a `400`.
- `PORT` sets the port, 3000 by default.

## Notes
No rate limiting yet on `POST /links`.

## Related Notes
- [[2026-10-12_src_codes.js]]
- [[2026-10-12_Add_rate_limiting_to_the_shortlinks_create-link_endpoint_before_launch]]
