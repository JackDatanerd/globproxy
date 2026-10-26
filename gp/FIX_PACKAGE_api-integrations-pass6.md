# Section 6 (Public API & integrations) — pass 6

No migration. Tests: tests/api-integrations.test.mjs (5 new).

1. Webhook queue drain: RETRIES_PER_RUN 24→60, PER_ENDPOINT_PER_RUN 3→12; a group stops after 2 consecutive failures so a dead endpoint cannot burn the tick. Revoke-all (25 events) now clears in ~2 ticks, not ~45 min. Retry endpoint-lookup errors no longer fail a delivery for good.
2. DB errors are no longer "not found": getOwnedCredential throws (malformed ids still null); getEndpoint, listDeliveries, rotateSecret, sendTestWebhook, redeliverWebhook, redeliverFailedWebhooks, planKeyUpdate, rotateApiKey surface a 500; loadKeyOwner fails closed (dashboard key POST/PATCH answer 503). Bulk actions (v1 + dashboard) isolate a failing item as a 500 result.
3. Bulk pause: whole-account usage sync only for batches > 5 (v1 + dashboard); smaller batches refresh just their own sessions.
4. Idempotency: credential stamps older than the 24h claim window are released instead of replayed (IDEMPOTENCY_WINDOW_MS shared with the prune).
5. Webhook secret rotation is compare-and-set (409 on a concurrent rotation).
6. Expired API keys can no longer be edited back to life (409: rotate instead).
7. Rotate grace inputs are strict (graceInput): null/""/non-numbers no longer mean 0 (instant revoke).
Docs + OpenAPI updated (burst timing, expired-key edits, rotate-secret 409).
