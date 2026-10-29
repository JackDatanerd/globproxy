# Proxy lifecycle — round 5 (independent pass, section 4)

Bugs only; no feature gap was necessary. Typecheck, schema/cron/api-docs/supplier guards and the suite (242 tests) pass.

## Bugs
- **B1 — provisioning undid a port edit.** `provisionPendingCredentials` wrote `port` from the protocol / session type it claimed minutes earlier, overwriting an edit the customer made to the still-pending session (stale port, connections refused until re-edited). The activation update no longer writes `port` (set at create, rewritten by every edit).
- **B2 — dashboard session PATCH edited terminated sessions.** Now `.is('terminated_at', null)` on every update, matching the v1 route.
- **B3 — retry route answered a database error with 404.** Validates the id and answers 503 on a lookup error.

## Risks closed
- **R1 — delete refund after a failed local transaction.** The frozen final usage is now saved to `gb_used` (compare-and-swap, daily ledger credited) before the supplier sub-user is deleted, so a retry refunds against real usage instead of the last-synced figure.
- **R2 — release lowered the live cap before the auto-allocate check.** The same rule (and wording) is checked first; a refused release no longer touches the supplier.
- **R3 — limit reconciler could lift a delete freeze.** A delete holds a short-lived `delete:<id>` claim; `syncCredentialLimit` skips a session while it is held. A second concurrent delete answers 409.
- **R4 — dashboard top-ups were not idempotent.** `POST /api/dashboard/proxies/:id/topup` and bulk top-up accept `Idempotency-Key` (no stale takeover; bulk is per item). ProxyCard / ProxyList send a key that stays stable until the top-up is known to have landed. `apiJson` takes optional extra headers.

## Files
lib/credentials.ts, lib/clientApi.ts, app/api/dashboard/proxies/[id]/{topup,retry}/route.ts, app/api/dashboard/proxies/bulk-action/route.ts, app/api/dashboard/sessions/[sessionId]/route.ts, components/dashboard/{ProxyCard,ProxyList}.tsx, tests/proxy-lifecycle-pass13.test.mjs. No migration.
