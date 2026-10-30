# FIX PACKAGE — api-integrations pass 10 (c6)

Independent re-audit of Public API & integrations. No migrations, no schema changes.

## M1 (medium) — dead webhook endpoints starved everyone else's retries
`runWebhookRetries` charged its 60-slot budget when rows were *selected*, but a failing endpoint's group
stops after 2 attempts. Ten dead endpoints with older due rows filled every slot, were never actually tried
beyond two rows each, and — being oldest — won the slots every tick, so healthy tenants' retries and deferred
events (usage alerts, key-revocation notices) were never delivered. Selection now runs in passes, the budget is
spent on attempts, stopped endpoints are excluded, and paging is keyset-based. (lib/webhooks.ts)

## L1 — `record_webhook_attempt` RPC error ignored → now logged.
## L2 — reminder cooldown 429 had no `Retry-After` → added.
## L3 — redeliver-failed charged `limit-1` writes before knowing the batch size → charged for the batch actually sent.
## L4 — PATCH invitation mapped 400→404 by regex on the message → `isUuid` pre-check + `failFrom`.
## L5 — docs status-code table lacked 413 → added.

Not changed (unverified): batching of housekeeping prune deletes.

**Tests:** tests/c6-round2-fixes.test.mjs (+6).
