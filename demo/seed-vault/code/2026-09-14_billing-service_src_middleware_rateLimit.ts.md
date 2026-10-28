---
title: "Redis token-bucket rate limit middleware for the billing API"
date: 2026-09-14
tags: [typescript, express, rate-limiting, redis]
related: []
source: "ide-webhook"
type: "code"
project: "billing-service"
session: "0b6f2c1e-4d3a-4f7e-9a51-2c8e7d10a914"
---

## Summary
Express middleware that rate-limits the billing API per API key with a token bucket stored in Redis. Each request takes one token; tokens refill continuously at the configured rate, so a client can burst up to the bucket size and then settle at the steady rate.

## Key Points
- `rateLimit({ capacity: 60, refillPerSecond: 1 })` returns the middleware; the bucket key is `ratelimit:<api key>`.
- The take-a-token step is one Lua script (`EVALSHA`), so concurrent requests on several instances can't both spend the last token.
- Over the limit it answers `429 Too Many Requests` with a `Retry-After` header in whole seconds.
- Buckets expire in Redis after an hour idle, so abandoned keys don't pile up.

## Notes
Keyed by API key rather than client IP because the billing API sits behind a load balancer and every partner sends from a handful of IPs.

## Related Notes
- [[2026-09-14_Rate-limit_the_billing_API_with_a_token_bucket_per_API_key]]
- [[2026-09-15_Fixed-window_rate_limits_let_a_client_send_twice_the_limit_across_a_window_boundary]]
