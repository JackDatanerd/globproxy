# FIX PACKAGE — Proxy lifecycle (independent pass 1)

Base: `fced3af`. Scope: `lib/geonode.ts`, `proxyEndpoint`, `geoTargeting`, `bandwidth`, `usageSync`, `autoTopup`, `stockStatus`,
`networkProbe`, `ipWhitelist` and `api/dashboard/proxies/*` (create, top-up, whitelist, sessions, usage).
IDs (PL-Bn / PL-Gn) match the audit report.

The repo moved several times while this round was in progress (this package is rebased on `fced3af`). Other sessions independently fixed a large part of the
findings, so everything they closed was **dropped from this package** rather than duplicated (see "Already closed upstream").
What follows is only what was still open on `fced3af`.

## Deploy order

1. Run `supabase/migrations/0046_proxy_lifecycle_residuals.sql`. Additive and idempotent. Do it **before** the code deploy: the new
   auto-top-up code calls `auto_topup_credential()`. Old code is unaffected by the new objects.
2. Deploy. No new wrangler binding, no new env var, cron chain unchanged.
3. Run the checks below.

## Verify live (cannot be checked from the repo)

- **Whitelist semantics (PL-B10).** Whitelist one IP on a test credential, then connect from a *different* IP with valid
  credentials. If it still connects, the whitelist is "allow without a password", not a restriction. The UI copy no longer claims
  either way; update it once you know.
- **Stock maths (PL-B9).** Confirm `/traffic`'s `availableForAllocationMB` is net of sub-user allocations (the code comment says so;
  the new exposure formula depends on it).
- **Prod lock-down is real.** `select proname from pg_proc p where pronamespace='public'::regnamespace and prokind='f' and
  (has_function_privilege('authenticated',p.oid,'execute') or has_function_privilege('anon',p.oid,'execute'))` should list only
  `is_admin` and `generate_unique_referral_code` (0042 §1b did the lock-down; this just confirms it landed).

## Fixed in this package

| ID | Fix |
|----|-----|
| PL-B8 | **Auto-top-up race.** The "is it due" decision is now made under the row lock (`auto_topup_credential`, 0046); two overlapping runs can no longer both top up. Only a genuine `Insufficient` error sends the shortfall email (a deleted/changed credential used to trigger it). Suspended owners are skipped. Per-run cap (12). `set_auto_topup`/`set_default_auto_topup` reject `amount <= threshold` at the DB, not just in routes. |
| PL-B6 | **Top-up cap drift.** The live Geonode cap is pushed from the *current* DB value, then re-read and re-pushed if a concurrent top-up landed (`syncCredentialLimit`). Previously two concurrent top-ups could leave the older, lower PATCH last, "succeed", and never be retried. |
| PL-G2 | **Limit reconciliation + orphan sweep.** Every usage sync compares Geonode's `trafficLimitMB` to the DB and heals drift (max 15 PATCHes/run). Sub-users on Geonode with the `gp_` prefix and no DB row (any status) are reported after two consecutive sightings → `platform_settings.geonode_orphans` + one admin email. Active credentials missing from a *complete* listing are logged. |
| PL-B7 | **Usage-sync honesty.** An incomplete Geonode listing no longer stamps `usage_last_synced_at`, skips auto-top-ups on stale usage, and fails the run (the freshness watchdog now actually fires on an outage). All full-table scans are paginated past PostgREST's 1000-row cap. The cron wrapper reports the failure in its body instead of halting the `*/5` chain (webhook retries/provisioning don't depend on Geonode). |
| PL-B9 | **Stock exposure.** Was `Σ(allocated − used)` compared against an already-net figure (double count) and ignored the real liabilities. Now: unallocated customer balances + pending credentials. Hourly alert de-duplicated (24 h reminder, clears on recovery). Admin panel text updated. |
| PL-G5 | `session_exhausted` webhook + email: once per exhaustion of a single credential (not sent when auto-top-up is on, or the owner is suspended; re-arms when headroom returns). |
| PL-G6 | Per-account cap of 100 active/pending credentials (DB trigger + friendly pre-check before any reservation/Geonode call). Rate limit on dashboard create/top-up/retry (existing limiter binding). |
| PL-G4 | **Edit in place** from the dashboard (`PATCH /api/dashboard/proxies/:id` + "Edit" tab), sharing one implementation with `PATCH /api/v1/sub-users/:id`. Fixes an edge case in the v1 PATCH: changing only `country` kept the old state/city (e.g. `country-de-state-california`); dependants are now cleared unless sent. Reseller-allocated and suspended sub-users can't be edited. |
| PL-G1 | Pending credentials: "Retry now" button + `POST /api/dashboard/proxies/:id/retry` (same atomic claim as the cron). The UI no longer promises "under a minute". |
| PL-B11 | Sticky quick-copy endpoint id derived from the credential id, not `Math.random` per mount (the IP changed on every page load). Session ids use `crypto` with rejection sampling. |
| PL-B12 | Network probe: "Proxy exit confirmation" now reads the body and requires an IP that differs from a direct request (a proxy that fails open used to score 100%). Targets run in parallel. |
| PL-B13 | Usage history: 10 credentials × ≤3 upstream calls (the old 15 × up to 5 could blow the 50-subrequest budget); `breakdown_truncated` flag; corrected the "CSV not capped" claim. |
| PL-B14/15 | 12 s timeout on every Geonode call; usage precision 0.0001 GB (was 0.01 → up to ~5 MB unaccounted per delete cycle); `createSubUser` refuses a 0 MB limit and a missing id (no more username-as-id); `updateSubUserTrafficLimit` refuses < 1 MB. |
| PL-B10 | Whitelist copy no longer asserts an unverified restriction. |
| misc | `lifetime-NaN` / unbounded sticky durations in `buildProxyUsername`; IPv4-mapped IPv6 accepted; `getHostCountryStats` page-size mismatch for `limit > 5000`; debug sub-user port from `getProxyPort`. |

## Already closed upstream (dropped from this package)

PL-B1/B2 (reserve/release + `proxy_credentials` write policies, 0040) · PL-B3/B4 (upstream-delete-must-succeed + atomic
`delete_own_credential`) · PL-B5 validation (`apiValidation.ts`) · pending-credential claim/backoff/cron (`claim_pending_credentials`,
`provision` task) · `LIMIT_SYNC` retry marker · default-privileges lock-down of every SECURITY DEFINER function (0042 §1b) ·
account suspension capping live proxies (`lib/adminProxy.ts`) · "use my IP" · amount > threshold checks in the three routes ·
session label/cap · session `PATCH` 404 · zero-filled usage chart · most webhook events.

## Notes on interactions

- `lib/adminProxy.ts` suspends by capping each sub-user and flipping the credential to `status='suspended'`. That loop is best-effort
  per credential; if one cap call fails, that credential stays `active` and keeps serving. The usage-sync reconciler now applies the
  same cap to any `active` credential under a suspended owner on the next tick. It never touches ones already `suspended`.
- `disableUserCredentials` does a sequential GET + PATCH per credential (up to 100 accounts' worth). On a Workers plan with a
  50-subrequest cap a large account will fail partway — the reconciler above is the safety net; worth a batch/limit there.
- The webhook event list is derived from `lib/webhookEvents.ts` everywhere (UI, API validation); the DB CHECK constraint is
  updated in 0046 for `session_exhausted`.

## Not done (deliberately)

- **Password rotation / explicit disable flag** — Geonode's API for these isn't verifiable from the repo.
- **Per-day history for deleted credentials** — consumed GB is archived into `used_gb`, but Geonode's retention for a deleted
  sub-user's stats is unknown. Documented in the route.
- **Unlimited-residential / datacenter product lines** — a product decision.

## Verification

- `tsc --noEmit` clean; `next build --webpack` succeeds (exit 0); `check-schema-sync` OK through 0046.
- Postgres 16 with Supabase-style default privileges (the stub lacks Supabase's `auth.sessions`, so upstream's own `list_auth_sessions` fails to create in the sandbox — unrelated to this package), **fresh install** (new `schema.sql`) and **upgrade** (`fced3af` schema + 0046,
  applied with `ON_ERROR_STOP`, re-run idempotent): overlapping auto-top-up returns NULL on the second run (no double top-up,
  reservation not double-counted); misconfigured amount ≤ threshold raises instead of looping; only a real balance shortfall yields
  `Insufficient`; 100-credential cap enforced (suspended rows don't count; freeing a slot allows one more); webhook constraint
  accepts `session_exhausted` and rejects junk; new functions are not executable by `authenticated`/`anon`.
- 98 TypeScript checks against fakes (not committed — the repo has no test runner): limit sync reads fresh values and re-pushes on a
  concurrent top-up, marks `LIMIT_SYNC` on failure; incomplete listing ⇒ no freshness stamp / no auto-top-up / run fails; drift,
  suspended-owner cap, orphan two-sighting rule, exhaustion notice rules and re-arm; auto-top-up error classification, suspended
  skip, per-run cap; edit semantics; probe against a real local TCP fake proxy (fail-open, junk body, chunked, 407).
- Not run: a live Geonode/Supabase deployment.
