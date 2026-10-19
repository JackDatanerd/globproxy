# FIX PACKAGE — Reseller, affiliates & payouts (Oct 2026, pass 1)

Base: `4587ce8`. Section: `app/reseller/*`, `api/reseller/*`, `lib/referrals.ts`, `lib/payoutCycle.ts`, apply / payout-method routes, referrals UI — plus the code/DB they depend on.

## Deploy order

1. `0043_admin_hardening.sql` must already be applied (this package builds on it).
2. Run `supabase/migrations/0044_section7_affiliates_resellers_hardening.sql` in the Supabase SQL editor. Idempotent.
3. Deploy the code. **Old code keeps working between 2 and 3 except one thing:** step 2 drops the RLS policy that let resellers read their clients' profile rows, so the *old* reseller pages show blank client emails until the new code is live. Do 2 and 3 back to back.
4. Add the new rate-limiter binding (it's in `wrangler.jsonc`, namespace `1005`) — deploying `wrangler.jsonc` does this. If the binding is missing, the limiter fails open (same as the existing ones).

No new env vars. Optional: `REFERRAL_IP_SALT` (falls back to `CRON_SECRET`) salts the signup-IP hash.

## What was already closed by the other passes (not re-done)

The concurrent passes fixed a large part of this section's audit; this package **does not redefine any of it** (0044 touches none of those functions):

| Audit item | Closed by |
|---|---|
| B1 held-back commissions stranded forever (+ claim-then-size) | Admin pass, `0043` |
| B8 orphan `mark-commission-paid` double-pay | Admin pass (route retired) |
| B7 `run-payout-cycle` validation, bad dates, negative hold | Admin pass |
| B9 deleted/suspended affiliates being batched & paid | Admin pass (`ineligible`) |
| Refund → commission reversal (and refund-before-commission race) | Admin pass (DB triggers) |
| Payout `paid_by` + `payment_reference`, `notified_at` only on success | Admin pass |
| Audit log, affiliate suspend/reinstate/edit-rates, VO prior-rate restore | Admin pass |
| B3 apply-affiliate / apply-reseller status overwrite, rate limit | Auth & MFA pass |
| B5 referral reward lost when an email throws (post-credit retry) | Security pass, `0041` |
| PII wipe on self-service account deletion | Security pass |

I verified my SQL composes with theirs (their payout run → my payout void → re-run; their refund trigger → my commission function; see tests below).

## Bugs fixed here

| # | Bug | Fix |
|---|---|---|
| B2 | **Resellers could read the entire `profiles` row** (payout bank details, M-Pesa number, wallet, application blobs) of every user they'd ever transferred to, via RLS. Any registered user could be made a "client" with a dust allocation. | Policy dropped. Reseller pages read a narrow `SECURITY DEFINER` roster (id, email, name, totals only). Allocation now has a 0.1 GB minimum, per-reseller rate limit, and one generic "no active account" answer (it used to distinguish missing / deleted / suspended). |
| B4 | `update-payout-method`: a non-string `accountNumber` threw *after* the write, so the change saved but the **security email never went out**; `bankName` was injected unescaped into that email; re-saving identical details restarted the 48 h hold; no checksum on the TRC20 address; no rate limit. | Everything validated before writing; email content escaped and built from validated strings; no-op saves ignored; real base58check validation (typos in a USDT address are unrecoverable); rate-limited; uses the shared MFA step-up. |
| B6 | `/reseller` returned 404 (approval email, MFA redirect and layout all point there). | Index page added. |
| B10 | Reseller "Quick Top-Up" sent **1 GB** when the field was blank or `0` (`parseFloat(x) \|\| 1`), irreversibly. | Strict parse; nothing is sent on bad input. |
| B11 | A non-string referral code threw *after* the account was created (500 on a successful signup). | Code is validated by type/shape inside the never-throws helper. |
| B12 | Reseller roster / earnings / referrals page summed client-fetched lists (silently capped at 1000 rows; "this cycle" used only the latest 20 commissions). | Computed in SQL (`reseller_client_roster`, `reseller_summary`, `my_affiliate_summary`, `my_referral_funnel`), paginated. |
| B13 | Referral copy promised "you both get 1 GB" to affiliates (who earn cash and whose referrals get nothing); 1 GB hardcoded in UI and emails. | Copy is truthful and reads `REFERRAL_GB_BONUS` / `REFERRAL_MIN_ORDER_USD`. A public code-check endpoint lets the signup page say what's actually true for that code. |
| B14 | Allocation history was a separate "non-fatal" insert (bandwidth moved with no record on failure); `gb_allocated` only truthiness-checked. | `allocate_reseller_bandwidth_tx` does stock check, move and history row in one transaction; 3-decimals / bounds enforced. |
| B15 | Earnings page counted *transfers* as "active clients" and showed a "pending" tile nothing could populate. | Replaced with real figures; page renamed "Stock & Activity" and says plainly that revenue isn't tracked. |
| B9 | Deleted / suspended referrers could still be attributed and credited; deleting an affiliate left their status active and unpaid earnings payable. | `record_referral_signup`, `credit_referral_bonus`, `record_affiliate_commission` refuse them; `scrub_affiliate_data()` (called from both deletion paths) suspends the status and forfeits unbatched earnings. Batched/paid payout rows are kept as financial records. |
| B17 | `referral_code` wasn't pinned (users could rewrite their own); 0031/0034 claimed idempotency but weren't; "stay active" / "double" copy; client-side date label off by a day in negative-UTC zones; stale `referralConfig.ts` reference. | Pinned in the profile trigger; migrations made idempotent; copy corrected; `timeZone: 'UTC'`. |

## Feature gaps closed

* **Referral attribution that survives browsing.** First-party 60-day cookie set by `/r/CODE[?sub=tag]` *and* by any page carrying `?ref=` (`<RefCapture/>`); first touch wins. Optional "referral code" field on signup; `claim_referral_code` lets an existing account add a code **before its first purchase**. Click counter + per-link campaign tags (`sub_id`), shown per signup in the dashboard.
* **Fraud controls.** gmail-dot / `+tag` alias self-referral refused; a second signup from the same IP on one referrer is **flagged** and earns nothing until an admin clears it (new `/admin/referrals` page); the standard GB bonus now needs a minimum order ($5).
* **Affiliate dashboard.** Payable / scheduled / paid, progress toward the $20 minimum, next payout date, payout-hold notice, per-referral funnel (masked identity, join date, first purchase, orders, earned), suspended state, load-failure banner.
* **Payout operations.** *Void payout* (cancels a still-pending payout, releases its commissions, frees the cycle slot, full details to the audit log); *Export CSV* bulk-pay sheet from the destination snapshot; **the 48 h hold now restarts on every account-takeover step** — password change, email change/request, MFA disable, admin MFA reset, backup-code regeneration — via one trigger on `security_events` + the email-sync trigger.
* **Reseller tooling.** *Reclaim* the unused part of a transfer (client is emailed; only unused, unassigned GB can move), private transfer notes, bulk allocation (paste `email, GB, note`), client search + pagination, per-client usage visibility, transfers CSV export, honest stock/consumption overview.
* **Legal.** Terms: Referral & Affiliate Programs section (matches the implemented rules). Privacy: payout data, IP-hash and click counting, retention on deletion, and the **referral cookie** (the page previously said "only essential cookies"). **Have counsel review this text** — I wrote it to match behaviour, not as legal advice.

## Deliberately not built

* **Commission maturity window / automatic clawback netting for already-paid commissions.** I'd built both, then dropped them in favour of the Admin pass's design (reduce pending, audit-log already-paid for manual follow-up) rather than ship a second, conflicting payout function.
* **Reconcile cron for lost rewards** — the `0041` post-credit retry already does this.
* **Invite flow for unregistered client emails** — it would turn the allocate endpoint into an email cannon and a registered-email oracle. Resellers can share their referral link instead.
* **Card/device fingerprinting for self-referral** — needs payment-processor data; the alias + shared-IP checks catch the lazy cases only. A determined abuser with a second IP and email still gets through; the admin can void via suspension.
* **Local-currency (KES) amount / FX rate on payouts, rejection reasons, per-affiliate detail page, click-through QR/share buttons** — nice-to-have, not built.

## Verified

* `tsc --noEmit` clean; `next build --webpack` passes; `check:schema` OK through 0044.
* Real Postgres 16 with Supabase-style stubs **and default privileges**: full `schema.sql` loads with 0 errors; `0044` applies to the pre-0044 schema, twice, with 0 errors; the SECURITY DEFINER exposure query from `0043`'s notes returns **0 rows**.
* SQL behaviour tests (all pass): attribution + sub-ID, alias self-referral, shared-IP flag, flagged referral earns nothing then earns after clearing, refunded-order commission reduced (their trigger) with my commission function, bonus minimum/idempotency, their payout run → my void releases commissions → re-run recreates → paid payout can't be voided, summary/funnel, click counter, scrub, deleted referrer refused, hold restarts on `mfa_disabled` / `password_changed` / email change but **not** on `login`, allocate bounds, reclaim only moves unused GB, wrong reseller refused, **reseller sees 0 rows of a client's profile**, plain user can't rewrite `referral_code`.
* Built server smoke test: `/r/CODE` → 307 with first-touch cookies, junk codes rejected, `/reseller` → login, new routes 401 when unauthenticated, Terms render.
* TRC20 validator tested against real addresses and single-character mutations.

## Not tested (be honest)

* Not run against live Supabase / Paystack / Resend / Cloudflare. UI was type-checked and built, **not clicked through** — especially bulk allocation, reclaim and the admin void/export buttons.
* The signup-IP hash relies on `cf-connecting-ip`; behind anything else it's `null` and the shared-IP flag simply never fires.
* Concurrency (allocate vs reclaim lock ordering) is reasoned about and enforced with ordered row locks, not load-tested.

## After deploying — run these

```sql
-- 1. Must return 0 rows (any SECURITY DEFINER fn callable by signed-in/anon users).
select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef and p.prorettype <> 'trigger'::regtype
  and p.proname <> 'is_admin'
  and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));

-- 2. B2 check: the reseller→client profile policy must be gone. Must return 0 rows.
select policyname from pg_policies
where schemaname = 'public' and tablename = 'profiles' and policyname = 'Resellers can view own client profiles';

-- 3. Referrals flagged for review (worth a look after a week).
select count(*) from public.referrals where flagged;

-- 4. Past exposure: bank/M-Pesa/wallet details that resellers could have read.
--    Affiliates who were ALSO someone's reseller client:
select distinct p.id, p.email
from public.reseller_transfers t join public.profiles p on p.id = t.recipient_id
where p.payout_method is not null;
```

Check 4 matters: B2 was readable by any reseller, so if it returns rows consider whether those affiliates should be told and their payout details rotated.
