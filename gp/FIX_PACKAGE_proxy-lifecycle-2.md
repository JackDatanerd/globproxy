# FIX PACKAGE — Proxy lifecycle, pass 1 (round 2) (Oct 2026)

Base: `3b24dc2`. Section: `lib/geonode.ts`, `proxyEndpoint`, `geoTargeting`, `bandwidth`, `usageSync`, `autoTopup`, `stockStatus`, `networkProbe`, `ipWhitelist`, and `api/dashboard/proxies/*` (create, top-up, whitelist, sessions, usage) — plus the v1 routes, cron tasks, DB functions and UI they run through.

## Deploy order

1. Run `supabase/migrations/0059_proxy_lifecycle_closeout.sql` in the Supabase SQL editor. Idempotent.
2. Deploy the code **immediately after** — do 1 and 2 back to back. Step 1 makes the proxy username/password and other upstream columns unreadable with a customer session (that is the point of B1), so the *old* Proxies page, whitelist routes and usage-history route (which read them with the customer session) fail until the new code is live. The *new* code needs the new columns, so deploying it first fails the other way.
3. Nothing to add to `wrangler.jsonc` (uses the existing `USER_ACTION_RATE_LIMITER`).
4. Optional: set `PASSWORD_ROTATION_ENABLED=true` **only after** the live check below. Off by default; the button and endpoints stay inert.

## What the other passes already closed (not redone)

| Audit item | Closed by |
|---|---|
| MFA step-up on every proxy route | Auth & MFA passes (`requireMfaVerified` on all of them) |
| Per-user limiter on whitelist, top-up, retry, create, usage history | Edge pass (same `rateLimitedUser` calls) |
| Supplier-named columns, raw error text in `last_provision_error`, raw message relay in whitelist errors | Dashboard UI / Auth passes (0049, 0050) |
| Strict shared `parseAutoTopup` on the dashboard + v1 auto-top-up routes | API & integrations pass |
| 90-day usage range | Dashboard UI pass |

Where my work overlapped theirs I took theirs (conflicts resolved toward upstream) and kept only what was missing.

## Bugs fixed here

| # | Bug | Fix |
|---|---|---|
| B1 | A customer session could read **every column** of their `proxy_credentials` rows straight from the REST API — the proxy password, upstream sub-user id and provisioning bookkeeping — including a password-only session that had not passed MFA. | Column-level SELECT (`0059`): customers get the safe columns only (fail-closed: a new column needs an explicit grant). The Proxies page, whitelist routes and usage history read secrets server-side with the service role, scoped to the signed-in user. Pending sessions expose a neutral `pending_reason` instead. |
| B2 | The usage-sync staleness watchdog ran *after* a call to the provider, so during the very outage that makes sync stale it never ran; nothing alerted on a failing provider API. | Watchdog first and independent; provider failure emails the admin once per 24 h; the cron run is recorded as failed. |
| B3 | A session with auto-allocate enabled got **no** exhaustion notice and no dashboard warning even when auto-allocate could not run (empty balance). | Suppressed only while auto-allocate can actually act; flagged sessions get the notice (with a "buy bandwidth" call to action) and the banner. |
| B4 | Credential delete/edit were un-throttled against the shared provider key. | Per-user limiter on delete, edit, release and rotate. |
| B6 | A suspended/deleted owner's pending sessions were provisioned live at full cap until a later sync capped them; and the cron gave up forever after 30 attempts. | `claim_pending_credentials` skips inactive owners; no attempt ceiling (backoff already tops out at 6 h). |
| B7 | A customer's slow webhook endpoint stalled the usage sync for everyone (first delivery attempt ran inline, 8 s timeout). | Cron-driven events are queued and delivered by the webhook task. |
| B8 | A provider page cap below 100 made a partial listing look complete. | Listing ends on an empty page; a repeated page is reported incomplete. |
| B9 | A missing usage figure was read as 0 GB and could overwrite real usage. | Missing/non-numeric usage is `null` / throws; never written. |
| B10 | Auto-allocate with an unfundable size failed silently every 5 minutes forever; one already-alerted session cost an RPC every tick; no bounds on create-time values. | Customer is told once; no RPC for already-alerted accounts with no balance; bounds in the DB function and every route. |
| B11 | Customers could create named sessions straight through the REST API, bypassing the cap, the sticky-only rule, the suspended check and token-format rules. | DB trigger + token CHECK; dashboard cap aligned to the API's 200; terminated sessions purged after 7 days. |
| B12 | Edit tab and delete button shown on reseller-allocated sessions (server 403s); a 45-minute API session rendered as "1 min". | UI mirrors the server rule; custom duration supported. |
| B13 | Stock exposure counted suspended and deleted accounts. | Excluded. |
| B14 | The public status benchmark probed with the bare username, not the shape customers use. | Uses the customer username shape. |
| B15 | Whitelist accepted private/loopback/documentation addresses that can never match. | Public-IP check on add (removal still accepts anything valid). |

## Feature gaps built

- **Release unused GB** back to the balance without deleting the session — dashboard (Bandwidth tab), `POST /api/v1/sub-users/:id/release`, `session_released` webhook. Live usage is read from the provider first; nothing is released if that fails; the provider cap is lowered before the DB releases the reservation (and restored if the DB refuses).
- **Password rotation** — dashboard button, `POST …/rotate-password` (dashboard + v1). **Gated** (see below).
- **Stalled and vanished sessions** — pending > 6 h: one customer email + one admin email; active session whose upstream sub-user is gone for 10+ min: admin email once per incident and a "needs attention" notice on the card.
- **Partial auto-allocate funding** — tops up with whatever the balance covers (min 0.01 GB), tells the customer once.
- **Per-session low-bandwidth warnings** at 80 % and 95 % (email + `session_low` webhook, one email per customer per tick).
- **ISP/ASN picker** per country (13,155 ASNs in `public/geo/asns/`), validated server-side against the country.
- **Per-session usage drill-down** on the usage page; custom sticky duration (1–1440 min) in both forms; `auto_topup` on v1 create and bulk create (it was in the OpenAPI document but silently ignored).
- **Capacity vs outage** on pending sessions (`pending_reason`), reflected on the card and the retry message.
- Docs page and OpenAPI document updated; webhook CHECK now lists all 20 events (a stale list would have rejected endpoints subscribed to the newer ones).

## Verify password rotation before enabling it

The provider's documented PATCH accepts the creation fields; whether it really changes a sub-user's password is unconfirmed. On a throwaway session with `PASSWORD_ROTATION_ENABLED=true` in a staging deploy: rotate → confirm a connection with the **new** password succeeds and the **old** one is refused. If it silently does nothing, leave the flag off (customers would be shown a password that doesn't work).

## Decisions made (no input available)

- Checkout is **not** blocked when provider stock is low: sales continue, sessions queue as `capacity`, customers are told plainly, and you are alerted. Say if you'd rather gate checkout.
- Releasing keeps a 0.05 GB margin on active sessions and refuses amounts that would immediately re-trigger auto-allocate.

## Tests run

- Full `schema.sql` loaded into PostgreSQL 16 (Supabase auth stubbed) and exercised: release (success, over-release, stale live usage, auto-allocate guard, reseller block), partial/insufficient auto top-up, bounds, session trigger (cap, sticky-only, bad token, foreign credential, suspended owner), pending claim (suspended excluded, no ceiling), column grants as `authenticated` / `anon` / `service_role`, RLS-scoped inserts.
- 100 assertions on the changed TypeScript (pagination, usage parsing, error classification, validators, auto top-up loop, usage-sync notifiers and missing-upstream tracking, release/rotate/stalled) against a fake database and mocked provider.
- `tsc --noEmit` clean; `next build --webpack` compiles and type-checks (page generation needs a live database, not available here).
- Not tested: against the real provider, real email delivery, a browser.

## Files

New: `0059_proxy_lifecycle_closeout.sql`, `components/dashboard/AsnPicker.tsx`, `StickyDurationSelect.tsx`, release + rotate-password routes (dashboard and v1), `lib/geo/asnIndex.json`, `public/geo/asns/*.json`, `scripts/generate-asn-data.py`.
Changed: see the diff — `lib/{credentials,usageSync,autoTopup,geonode,webhooks,webhookEvents,ipWhitelist,apiValidation,stockStatus,networkProbe,proxyEndpoint,geoTargeting,openapi}.ts`, the proxy routes, cron route, proxies/usage pages and components, docs page, `schema.sql`.
