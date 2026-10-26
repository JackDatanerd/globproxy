# Section 6 (Public API & integrations) — pass 5

Bugs
- POST /api/dashboard/api-keys: a JSON body that is not an object (null, 5, []) threw → 500; now treated as empty.
- Idempotency: stale-claim takeover deleted any in-progress row for the key; now only the exact stale row (created_at match), so two racing retries cannot both run.
- POST /api/v1/orders: an Idempotency-Key replay returned a stored checkout_url even after the order was paid or retired by a newer checkout; replay now reports the order's current status and checkout_url=null unless pending. (onReplay hook in runIdempotent; OpenAPI + docs updated.)
- SSRF: creating/editing a webhook now fails CLOSED if the DNS lookup is unusable (delivery-time check still fails open so a resolver outage cannot stop all deliveries).
- Webhook auto-disable: 50 consecutive failures now also requires the streak to be >24h old (webhook_endpoints.failing_since; record_webhook_attempt rewritten). A 410 / disallowed address still disables immediately. Migration 0089.
- POST /api/v1/sub-users/:id/sessions: a raw table CHECK-violation message (names relation/constraint) is no longer echoed to clients.

Gaps closed
- Refused uses of a real key (revoked, expired, wrong IP, wrong scope) are now written to api_request_log (401/403, 1 row/key/min/isolate), so they show in Activity and GET /account/activity.
- New webhook event order_failed (payment failed/declined), emitted from lib/orderFailure.ts; CHECK constraint, docs and event catalogue updated.
- tests/api-integrations.test.mjs: SSRF guard, DNS fail-open/closed, IP allowlist, allocate pin, event catalogue vs DB CHECK constraint, 24h disable rule.

Notes
- migration 0089 folded into supabase/schema.sql (check:schema passes). If another session has taken 0089, renumber the file and re-run `node scripts/fold-migration.mjs`.
- Run the migration in Supabase before deploying (the new RPC reads failing_since).
- Verified: check:schema, check:api-docs, check:supplier, npm test (91 pass), tsc --noEmit clean.
