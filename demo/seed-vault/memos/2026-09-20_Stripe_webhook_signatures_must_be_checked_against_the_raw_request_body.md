---
title: "Stripe webhook signatures must be checked against the raw request body"
date: 2026-09-20
tags: [memo, learning]
related: []
source: "memo"
type: "memo"
kind: "learning"
project: "billing-service"
session: "9c41e7b2-6f0d-4e2a-b8c5-1d7f3a6e0920"
files: ["src/webhooks/stripe.ts"]
---

In the billing-service project, the Stripe webhook endpoint in `src/webhooks/stripe.ts` rejected every event with "No signatures found matching the expected signature for payload".

## Finding
`express.json()` ran before the webhook route and replaced the body with a parsed object. Stripe signs the exact bytes it sent, so verification needs the raw body: mount the route with `express.raw({ type: 'application/json' })` before the JSON parser, and pass `req.body` (a Buffer) to `stripe.webhooks.constructEvent`.

## Evidence
With `express.raw` on the route, `stripe trigger invoice.paid` verified first time; re-serialising the parsed body with `JSON.stringify` still failed, because key order and whitespace differ.
