# FIX PACKAGE — Public API & integrations (Oct 2026, pass 1)

Base: `ce1e353`. Section: `api/v1/*`, `lib/apiAuth.ts`, API keys, outbound webhooks
(`lib/webhooks.ts`, `api/dashboard/webhooks`), `docs/api`.

## Deploy order

1. Run `supabase/migrations/0054_api_integrations_closeout.sql` in the Supabase SQL editor
   (after 0053). Idempotent — safe to run twice. **Run it BEFORE deploying the code**: the new
   code writes `webhook_deliveries.response_body`, `api_request_log`, `proxy_credentials.idempotency_key`
   and `api_keys.expiry_warned_at`, and accepts the `allocate` scope. Deployed first, webhook
   delivery results would fail to record (the delivery itself still goes out).
2. Deploy the code. Old code keeps working between 1 and 2 (everything in 0054 is additive) except
   one deliberate change: it drops the RLS policy that let a logged-in browser read its own
   `webhook_endpoints` rows **including the signing `secret`**. No app code read that table
   directly (verified by grep), so nothing breaks.

No new env vars. No new wrangler bindings. `schema.sql` is in sync through 0054
(`npm run check:schema` passes).

## What the other passes had already closed (verified on a fresh clone, not re-done)

| Audit item | Closed by |
|---|---|
| Supplier name in API responses / docs (`supplier_username`) | Auth pass 2 (`upstream_*` rename); docs text removed |
| Upstream error text relayed on whitelist routes | `whitelistErrorResponse` now returns fixed messages |
| Cron chain starved by a failing usage sync | Proxy-lifecycle pass (usage wrapper swallows) — *plus* the independent-chain change below |
| `auto_topup_failed` mislabelled for non-balance errors | Proxy-lifecycle pass (only "Insufficient" is classed as such) |
| Webhook URL port scanner | Edge pass (443/8443 on create/edit; existing endpoints grandfathered). I had written the same rule applied at *delivery* time, which would have silently disabled existing odd-port endpoints — removed mine, kept theirs |
| `Retry-After` hard-coded 15 | Edge pass (full window) |
| Per-user throttles on key / webhook minting routes | Edge pass |

## Decisions I made (you said to make the call)

* **Supplier name:** already hard-removed upstream — nothing customer-facing in this section names
  the supplier any more.
* **Reseller allocation over the API:** its own **`allocate` scope**, never implied by `write`.
  A key may only use it when it has an **IP allowlist** (API keys skip the 2FA step-up the
  dashboard applies to the same action, so they must be pinned to the caller's servers) and every
  call needs an **`Idempotency-Key`**. Only reseller/admin accounts can hold the scope.
* **Money-moving calls never re-run on an unknown outcome** (top-up, bulk top-up, allocate,
  reclaim): if an earlier attempt with the same key died after possibly committing, the answer is
  `409` telling the client to check state and retry with a *new* key. Sub-user creation *is*
  allowed to take over, because a unique index makes a duplicate impossible.
* **`bandwidth_threshold_crossed.used_pct` now means actual usage.** It used to carry the
  *allocated* percentage (a reseller 95% allocated / 3% consumed got `used_pct: 95`). The payload
  now has `allocated_pct` (what triggers it) **and** an honest `used_pct`, plus `used_gb` /
  `allocated_gb`. This is a visible change for anyone who built on the old number; documented.
* `read` keys can read sub-user proxy passwords (same data as the dashboard). Left as is — it is
  the primary use of `GET /sub-users` — and now stated plainly in the docs.
* Webhook rotation default is **immediate** (right for a leaked secret); key rotation default is a
  **24 h** overlap (right for a planned rollout). Both configurable.

## Feature gaps closed

| # | Gap | Built |
|---|---|---|
| G1 | Reseller API could not allocate bandwidth | `GET/POST /reseller/allocations`, `POST /reseller/allocations/:id/reclaim`. Dashboard allocate/reclaim routes are now thin wrappers over the **same** `lib/resellerAllocation.ts` (one implementation; validation rules, messages and statuses verified identical to what section 7 shipped) |
| G2 | Idempotency on create only | Generic `runIdempotent()`; now on create, top-up, bulk create/top-up, allocate, reclaim. Scoped per endpoint |
| G3 | Key management thin | Edit in place (label / IPs / scopes / expiry — only **widening** needs step-up), rotate with grace, revoke-all, per-key **activity log** (mutating calls, 30 days), **expiry warnings** (e-mail + `api_key_expiring` webhook, 7 days ahead, once) |
| G4 | Webhook observability | Delivery detail (exact payload + first 500 chars of your endpoint's response), cursor pagination, event catalog endpoint, secret rotation with **grace window** (`X-GlobProxy-Signature-V2-Previous`), Settings UI for details/pagination/rotation |
| G5 | Missing events | `session_suspended`, `session_resumed`, `bandwidth_allocated`, `bandwidth_reclaimed`, `bandwidth_refunded`, `api_key_created`, `api_key_revoked`, `api_key_expiring` (all wired to real call sites) |
| G6 | Docs / spec holes | OpenAPI 3 at `/api/v1/openapi.json` (validated), docs updated for everything above, `X-Request-Id` documented |
| G7 | IPv6 CIDR | IPv6 addresses + CIDR in key allowlists (see B12) |
| G8 | Rate-limit visibility | `X-RateLimit-Limit` on every response (limits exported from one place) |
| G9 | Ergonomics | `GET /account`, `GET /orders/:id`, `/sub-users` filters (label, country, dates), `/orders` date filters, `POST /sub-users/bulk` (10), `POST /sub-users/bulk-topup` (20). Bulk calls require an `Idempotency-Key`; each item counts against the 30/min write limit |

## Bugs fixed

| # | Bug | Fix |
|---|---|---|
| B3 | `GET /account/bandwidth` swallowed DB errors → **200 with all zeros** | Error → 500 |
| B4 | Transient profile-lookup failure → **401**, so clients blamed (and deleted) a good key | 503 + `Retry-After` |
| B5 | Failed **manual redelivery cancelled the pending automatic retries** | Manual attempts on a `retrying` delivery record the result but leave schedule and attempt count alone |
| B6 | One failing cron task silenced the rest of the `*/5` chain | `*/5` chain is independent; the daily chain keeps its stop-on-failure `needs:` semantics |
| B7 | Idempotency stale-claim takeover could create a **duplicate sub-user** | Unique `(user_id, idempotency_key)` on `proxy_credentials`; the loser of a race deletes its upstream sub-user, releases its reservation and returns the winner |
| B9 | Threshold payload mislabelled (see Decisions) | `allocated_pct` + real `used_pct` |
| B10 | 11 docs curl examples had `\\` line continuations (broke on copy-paste) | Fixed |
| B11 | Webhook **signing secret readable from the browser** via RLS | Policy dropped (0054) |
| B12 | IPv6 allowlist compared as text (a key could lock itself out) | Numeric comparison, canonical storage, `::ffff:` mapped addresses, IPv6 CIDR |
| B13 | Unknown event names silently dropped on create/edit | Rejected, naming the offender |
| B14 | Any CHECK violation reported as "maximum of 10 endpoints" | Only the cap trigger's message maps to that |
| B15 | Key cap counted **expired** keys | Trigger counts live keys only |
| B16 | Raw Postgres text could reach customers (auto-topup, top-up) | `rpcUserMessage()` — only our own `RAISE` messages pass |
| B17 | Whitelist routes bypassed `withApiAuth` (no request id; bad JSON → "invalid IP") | Rewritten on `withApiAuth` |
| B20 | Test-webhook cooldown was check-then-insert (race) | Insert-then-verify earliest; 5 simultaneous clicks → exactly one test |
| B21 | Session `terminate:false` ignored; PATCH of a terminated session returned 200; session cap racy | Fixed (re-count after insert) |
| B24 | Receiver response body never consumed | Bounded read (kept as the delivery's response snippet), always cancelled |
| — | Auto-top-up config accepted absurd values and `"false"` (string) as enabled | Shared `parseAutoTopup()` (dashboard + API): strict boolean, bounds, ≤4 decimals, amount > threshold |
| — | Webhook error text distinguished refused / no-route / TLS | Generic ("Timed out", "Could not connect") |

Found while self-reviewing my own changes: rotating a key would have triggered the daily "your key
expires tomorrow" e-mail about the key the user had just replaced (fixed — the old key is marked
as already warned), and the new request log holds IPs so account deletion now clears it.

Deliberately not changed: B22 (no step-up on webhook redeliver/test/delete — they only act on
endpoints and payloads that were already validated; creating/changing/rotating *do* require it).

## Verification

* `tsc --noEmit` clean; `next build --webpack` succeeds; `check:schema` passes.
* Migration: full `schema.sql` loaded into a real Postgres 16 and 0054 applied on top, twice
  (idempotent). Tested: `allocate` accepted, bogus/empty scope sets rejected, 30 expired keys ignored
  by the cap, the 26th live key rejected, webhook-secret policy gone, new events accepted and
  unknown ones rejected, duplicate `(user, idempotency_key)` → `23505` while NULL keys stay free.
* 173 assertions across 6 suites run the **real** modules/route handlers against an in-memory
  database: IP allowlist (IPv6 spellings, CIDR, mapped, legacy entries); idempotency state machine
  (replay, mismatch, in-flight, unknown outcome, failure frees key, 8 parallel → one run);
  allocation/reclaim routes (scope, IP requirement, replay, uniform 404, 402); webhook engine
  (signatures incl. grace header verified with HMAC, retry preservation, generic errors, 410,
  cooldown race, cron retry); `createCredential` incl. the concurrent-duplicate race; key
  create/rotate/revoke/expiry warnings/deletion cleanup. The OpenAPI document passes a real validator.

**Not exercised:** a live Cloudflare/upstream/Paystack/Supabase run, and true multi-connection
Postgres concurrency (the race tests are single-process interleavings plus the DB's own unique
index). Please smoke-test once on a deploy: create a key with an IP allowlist, allocate with
and without an `Idempotency-Key`, rotate a webhook secret with a grace window, and send a test
event.

## Notes for neighbouring sections

* **Section 7 (reseller):** `api/reseller/allocate` and `reclaim` now delegate to
  `lib/resellerAllocation.ts`; behaviour is unchanged but edits to that logic belong there.
* **Edge/auth:** key create/rotate/edit use the same `rateLimitedUser` throttle and step-up as the
  existing key route; the new `/api/v1/openapi.json` is public (the middleware excludes `/api`).
