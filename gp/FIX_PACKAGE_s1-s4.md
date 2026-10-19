# FIX PACKAGE — S1–S4 audit findings (Oct 2026)

Base: `23900ce` (Auth & MFA). Covers the findings from the first four audit sections that were still open at that commit. Most of the S2 (auth/MFA) findings were already closed by `23900ce` and are not repeated here.

## Deploy order (this matters)

1. Run `supabase/migrations/0041_post_credit_retry.sql` — additive, safe any time.
2. **Deploy the code.**
3. Right after the deploy finishes, run `supabase/migrations/0040_proxy_credentials_lockdown.sql`.
   - New code creates credentials through the service-role client, so creation works before and after 0040.
   - Credential **delete** needs the `delete_own_credential` RPC that 0040 adds, so it 500s in the gap between deploy and 0040. Doing 0040 first would also break create/delete on the *old* code until the deploy lands. Deploy-then-0040 is the shorter gap.
4. **Revoke the API key that was committed in `gp/globproxy-api-test.sh`** (`gp_live_9ccee7…`). It is in public git history since `6e24f38`; removing it from the file does not un-leak it.
5. Run the three audit queries in the header comment of 0040 to see whether the reservation bypass was already abused.
   - If the unique index in 0040 fails to create, the duplicate-`geonode_sub_user_id` query shows why: resolve those rows and re-run.

## Critical

**C1 — any logged-in user could mint unlimited proxy bandwidth (S4).** Two independent holes, both fixed in 0040:
- `release_credential_bandwidth` / `reserve_credential_bandwidth` were granted to `authenticated` and only checked `auth.uid() = p_user_id`. A user could create a credential (real Geonode sub-user, N GB cap), call `release_credential_bandwidth` directly to hand the reservation back, and repeat.
- `proxy_credentials` had INSERT and DELETE RLS policies with no column limits. Anyone with the public anon key could insert rows with any `gb_allocated`, `status`, `gb_used` or another customer's `geonode_sub_user_id`; the next paid order then provisioned the forged cap at Geonode.
- Reproduced on the previous schema in Postgres 16 (double reserve/release, a 100,000 GB row inserted). After 0040 every one of those fails with `permission denied`.
- Fix: both RPCs are service_role only; INSERT/DELETE policies dropped and INSERT/UPDATE/DELETE revoked from anon/authenticated; `delete_own_credential()` does delete + release + archive in one transaction; CHECK constraints on `gb_allocated`/`gb_used`; unique index on `geonode_sub_user_id`.
- Code: new `lib/credentials.ts` (`parseGb`, `deleteOwnCredential`). `dashboard/proxies` POST/DELETE and `v1/sub-users` POST/DELETE use it. `gb_allocated` is now validated (finite, 0.01–100000, so it can't round to a 0 MB Geonode cap).
- A failed Geonode delete now **aborts** the delete (502, nothing changed locally). Before, it was swallowed, the row was removed and the unused GB was released while the sub-user stayed alive and usable. A 404 from Geonode counts as already gone.

## Security / correctness

| # | Fix |
|---|---|
| S1-1 | Removed the hard-coded API key from `globproxy-api-test.sh` (now `GLOBPROXY_API_KEY`). **You still must revoke it.** |
| S1-2 | `lib/ssrfGuard.ts` rewritten: IPv6 parsed into numeric groups and classified by range. Previously blocked real hosts starting `fc`/`fd` (fcm.googleapis.com, fdic.gov) and missed `::127.0.0.1`, `::7f00:1`, `::ffff:0:7f00:1`, `2002:7f00:1::`, `febf::`, `fec0::`, `localhost.`, `*.localhost`, `255.255.255.255`, TEST-NET. Added userinfo rejection. Verified with a 31-case harness. Still literal-only: a public name that resolves to a private IP (e.g. `127.0.0.1.nip.io`) passes; redirects are already never followed. |
| S1-3 | Security headers (HSTS, nosniff, X-Frame-Options, Referrer-Policy, Permissions-Policy) in `next.config.ts`. No CSP on purpose (Paystack inline popup + Turnstile + Supabase would break silently; add Report-Only first). |
| S1-4 | `middleware.ts`: redirects now carry the cookies Supabase set (refreshed session / sign-out deletions). Before, early redirects dropped them. |
| S1-5 | `wrangler.jsonc` `observability` enabled; `deploy.yml` serialised with a `concurrency` group. |
| S2-1 | `requireActiveUser` fails **closed** on a query error / missing profile (503) and is now on `usage/history`, `billing/export`, `apply-api-access`, `apply-reseller`, `apply-affiliate`, `update-payout-method`. |
| S2-2 | `delete-account`: wipes company, payout wallet/bank/M-Pesa, applications, 2FA seeds/backup codes/trusted browsers, webhook URLs+secrets, proxy passwords, and support-report emails; keeps orders/ledgers. Aborts (502) if Geonode cleanup fails instead of leaving live proxies behind a "deleted" account. No longer clears an existing suspension. Rolls back every field it cleared if the auth ban fails. Email copy now says what is actually removed. |
| S3-1 | **Post-credit steps are retriable** (0041): `orders.post_credit_done_at`. Activation of pending credentials + referral/affiliate crediting run after the claim as before, but the order is stamped only when they succeed; the hourly reconcile cron re-runs unstamped orders for 3 days (both steps are idempotent). Confirmation email stays attempt-once. Orders credited before 0041 are backfilled as done. |
| S3-2 | Cron also sweeps credentials stuck in `pending` (Geonode down at creation) after 10 min, instead of waiting for the customer's next purchase. Activation is now conditional on `status='pending'`, so the cron and a payment can't both provision a sub-user for the same credential. |
| S3-3 | `charge.failed` webhook: non-UUID `metadata.order_id` made Postgres error → 500 → Paystack redelivered forever. Now validated; falls back to the reference. |
| S3-4 | Paystack `fetch` calls have timeouts (10s verify, 15s initialize, 20s charge). |
| S1-6 | `usage/history` rate-limited (each call fans out up to 30 Geonode requests on the one shared reseller key). |
| S1-7 | User-facing routes no longer return raw DB/exception messages on 500 (15 sites). Admin and cron routes keep theirs. |

## Verified
- `tsc --noEmit` clean; `next build --webpack` (see result in the hand-off message); `check-schema-sync` OK through 0041.
- Full `schema.sql` loads with 0 errors on a fresh Postgres 16 (Supabase-style stubs); **old schema + 0040 + 0041** ends in the same state (same grants, indexes, trigger body, `schema_migrations` rows). Both migrations re-run cleanly (idempotent).
- Attack script as an `authenticated` user (release/reserve/insert/update/delete/`delete_own_credential`): all denied. Service-role path: reserve 5 → insert → delete with 2 used → `allocated 5→2`, `archived +2`, wrong owner → `Credential not found`.

## Not fixed — needs a decision or a bigger change
- **Leaked key is still in git history.** Revoke it (step 4). History rewrite on a public repo isn't worth it once revoked.
- **Auth email in Supabase after account deletion.** `auth.users` keeps the real email (banned, not deleted). Changing it risks fighting the profile-sync trigger; decide whether you want the email freed/anonymised there too.
- **Refund consequences:** a refund can't claw back GB already reserved in credentials, disputes only alert, and referral bonus/affiliate commission are not reversed on refund. Needs a policy (reverse commission? suspend credential? admin tooling).
- **Invoices render the current profile**, not a snapshot at purchase; seller address/tax ID blank. Needs a billing-snapshot column on `orders`.
- Admin Orders totals capped at 1000 rows by PostgREST and revenue is gross; reconcile re-alerts hourly on a mismatch; alerts are email-only (no table); no admin manual-credit tool; no checkout limits; USD only.
- TOTP/RLS: direct PostgREST reads still don't know about the custom 2FA step-up (already noted in `FIX_PACKAGE_auth-mfa.md`).
- No automated tests; `/status` `revalidate` is ineffective with `incrementalCache: "dummy"`; stale comments mention removed cron workflows; root README and old `FIX_PACKAGE_*.md` are committed.
