---
title: "Fixed-window rate limits let a client send twice the limit across a window boundary"
date: 2026-09-15
tags: [memo, learning]
related: []
source: "memo"
type: "memo"
kind: "learning"
project: "billing-service"
session: "5e2a9d47-1c8b-4b0e-8f36-7a4d2e9b0915"
---

In the billing-service project, while load-testing the old fixed-window limiter (an `INCR` counter per API key per minute) before replacing it, we saw one client get 120 requests through in two seconds against a limit of 60 per minute.

## Finding
A fixed window resets all at once. A client that sends its 60 requests at 12:00:59 can send 60 more at 12:01:00, so the real peak is twice the limit. Token buckets and sliding windows don't have the boundary, because capacity comes back gradually.

## Evidence
The load test (`k6 run load/burst.js`) sent 60 requests in the last second of a window and 60 in the first second of the next: all 120 got `200`.

## Related Notes
- [[2026-09-14_Rate-limit_the_billing_API_with_a_token_bucket_per_API_key]]
