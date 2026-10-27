---
title: "Rate-limit the billing API with a token bucket per API key, stored in Redis"
date: 2026-09-14
tags: [memo, decision]
related: []
source: "memo"
type: "memo"
kind: "decision"
project: "billing-service"
session: "0b6f2c1e-4d3a-4f7e-9a51-2c8e7d10a914"
files: ["src/middleware/rateLimit.ts"]
---

In the billing-service project (the TypeScript and Express API partners call to create invoices), partners were retrying failed invoice calls in tight loops and overloading the database. We added rate limiting in `src/middleware/rateLimit.ts`.

## Decision
A token bucket per API key: 60 tokens, refilled at one per second, stored in Redis and updated by a single Lua script. Over the limit, answer `429` with `Retry-After`.

## Alternatives rejected
- **Fixed-window counter** (`INCR` per minute): simplest, but a client can send the whole limit at the end of one window and again at the start of the next.
- **Sliding-window log**: exact, but stores every request timestamp per key.
- **Keying by client IP**: partners share load-balancer IPs, so one partner would throttle the others.
- **In-memory buckets**: the API runs on three instances, so each would allow three times the limit.

## Same Session
- [[2026-09-14_src_middleware_rateLimit.ts]]

## Related Notes
- [[2026-09-15_Fixed-window_rate_limits_let_a_client_send_twice_the_limit_across_a_window_boundary]]
