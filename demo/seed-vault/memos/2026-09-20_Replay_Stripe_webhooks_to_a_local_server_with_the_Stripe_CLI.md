---
title: "Replay Stripe webhooks to a local server with the Stripe CLI"
date: 2026-09-20
tags: [memo, snippet]
related: []
source: "memo"
type: "memo"
kind: "snippet"
project: "billing-service"
session: "9c41e7b2-6f0d-4e2a-b8c5-1d7f3a6e0920"
---

In the billing-service project, testing the Stripe webhook handler (`src/webhooks/stripe.ts`) locally without deploying.

## Snippet
```bash
# Terminal 1: forward test-mode events to the local server; prints the signing secret
stripe listen --forward-to localhost:3000/webhooks/stripe

# Terminal 2: fire a test event
stripe trigger invoice.paid
```

## What it's good for
Reproducing webhook bugs on a laptop. Put the `whsec_...` secret that `stripe listen` prints into `$STRIPE_WEBHOOK_SECRET` for the local server; it is a different secret from the dashboard's.

## Related Notes
- [[2026-09-20_Stripe_webhook_signatures_must_be_checked_against_the_raw_request_body]]
