# FIX PACKAGE — Admin & Verified Operators (Oct 2026, pass 1)

Base: `7654609`. Section: `app/admin/*`, `app/api/admin/*` (incl. `grant-verified-operator`), `components/admin/*`, plus the code/DB they depend on.

## Deploy order (this matters)

1. Make sure `0042_api_integrations_hardening.sql` (already on `main`) has been run — this package's functions rely on its default-privilege change, and it contains the SECURITY DEFINER lockdown described below.
2. Run `supabase/migrations/0043_admin_hardening.sql` in the Supabase SQL editor.
3. Deploy the code. (Old code keeps working between steps 2 and 3: the changed RPCs keep their old call shape. New admin pages show a red "has migration 0043 been run?" banner if you deploy first.)
4. Run the checks at the bottom of this file.

No new env vars.

## SECURITY DEFINER lockdown — independently confirmed

While testing this section against a real Postgres seeded with Supabase's default grants I found that `REVOKE … FROM PUBLIC` leaves the explicit `anon` / `authenticated` `EXECUTE` grants in place, so every service-only SECURITY DEFINER RPC was callable by any signed-in user (`credit_bandwidth(own_id, 5000)` minted 5000 GB; `run_affiliate_payout_cycle(…, 0, 0)` forced payouts with the minimum **and the 48 h payout-method security hold** off; `mark_affiliate_payout_paid`, `wipe_mfa`, `claim_and_credit_order`, `apply_order_refund`, … likewise). The concurrent API & integrations pass (`0042_api_integrations_hardening.sql` §1b) found and fixed the same hole with a sweep over `pg_proc` plus a default-privileges revoke, so I dropped my own duplicate migration. **Run the check query in 0042's header on your live DB** to confirm it returns zero rows.

What this package adds on top: every function **it** creates (`run_affiliate_payout_cycle`, `mark_affiliate_payout_paid`, `admin_order_stats`, `admin_affiliate_earnings`, the two refund trigger functions) is explicitly revoked from `public, anon, authenticated` inside 0043, so they are locked regardless of what default privileges the project has. Tested as a plain `authenticated` user: all four callable functions return `permission denied`.

## Money bugs fixed

| # | Bug | Fix |
|---|---|---|
| B1 | Balances held back (no payout method, 48 h hold, below minimum) were **stranded forever**: the payout RPC only looked at commissions created *inside* the cycle window, while the email to affiliates promised "carries over automatically". | `run_affiliate_payout_cycle` now takes every unbatched pending commission earned on or before the cycle end. Tested: $5 (below min) + $18 next cycle → one $23.00 payout; $60 held for no method → paid next cycle. |
| B1b | Commissions were summed, then claimed in a separate statement; one inserted between the two would be claimed without being counted. | Claim first, size the payout from what was actually claimed. |
| B2 | `mark-commission-paid` could mark an already-batched commission paid, then the whole payout was paid again (**double pay**). No UI used it. | Route retired (returns 410). `mark_affiliate_payout_paid` only flips still-pending commissions. |
| B3 | Refunds never touched affiliate commissions. | Trigger on `orders.refunded_usd`: reduces the commission pro-rata (void on full refund) and shrinks a still-pending batched payout. A commission **already paid** can't be recovered automatically → `commission_refund_after_paid` row in the audit log. |
| B3b | A refund landing *before* a retried post-credit step created the commission would be missed. | Before-insert trigger applies any existing refund to a new commission. |
| B10 | Deleted / suspended / non-approved affiliates were batched and paid. | Reported `ineligible`, left unclaimed (paid if reinstated). Pending-payout rows for such accounts are flagged in the UI. |
| – | Payouts recorded no actor or evidence. | `paid_by` + `payment_reference` (prompted when marking paid, shown to the affiliate and in "Recently paid"). `notified_at` only set when the email was actually accepted. |
| – | `run-payout-cycle` accepted negative minimum / hold, bad dates, future cycles; N+1 emails. | Validated (real calendar dates, cycle must have ended, min 0–100000, hold 0–720 whole hours); one profile query; sends in batches of 10. |

## Security / correctness bugs fixed

| # | Bug | Fix |
|---|---|---|
| B4 | `suspend-user` worked on **deleted** accounts; "unsuspend" lifted the permanent ban. | Deleted accounts rejected (409). |
| B5 | Ban/unban errors were silently ignored (`.catch` never fires on supabase-js). | Checked. Suspend: profile rolled back if the ban fails. Unsuspend: ban lifted **first**; profile untouched if that fails. |
| B6 | Any `action` other than the literal `'suspend'` unsuspended. | Must be exactly `suspend` / `unsuspend`; no-ops rejected. |
| B7 | `approve-reseller` / `reject-reseller` could demote an admin (`reject` hard-set `role:'user'`). | Excluded admins; reject no longer touches `role`. |
| B9 | `delete-user` swallowed Geonode failures (orphaned billable sub-user, no retry possible) and its rollback lost suspension state. | Aborts with 502 *before* anything local changes; 404 = already gone. Full-row rollback. |
| B10b | Deletion left PII and secrets. | Brought to the same end state as the (concurrently improved) self-service route: payout details, applications, company, 2FA seeds/backup codes/trusted browsers, webhook URLs+secrets, proxy passwords/Geonode ids, support-report emails; API keys revoked; suspension preserved. Shared in `lib/accountDeletion.ts`. |
| B11 | Approve/reject "still pending?" check wasn't atomic. | Condition is part of the UPDATE (shared `lib/adminApplications.ts`). |
| B19 | `toggle_api_access` flipped from a read value (double-click undid itself) and granted API access to non-resellers. | Explicit `grant_api_access` / `revoke_api_access` (idempotent, resellers only). `make_user` clears API access. |
| B22 | `set-benchmark-credential` accepted any user's credential (would burn a customer's bandwidth) and silently no-op'd if the settings row was missing. | Own credential only; upsert. |
| B30 | `wipe_mfa` (security definer) had no `search_path`. | Set. |
| – | Verified Operator grant overwrote a higher rate; revoke hard-reset to 30/15; no notice on revoke. | Prior rates stored (`verified_operator_prev_rate*`, trigger-protected) and restored on revoke; never lowers a rate; atomic; revoke email. |

## Display / admin-UX bugs fixed

* **Revenue figures** now agree everywhere (Overview, Orders, Sales Cycles) via `admin_order_stats()` — server-side, **net of refunds**, canary excluded, and no longer truncated at PostgREST's 1000-row cap. Account counts / signup list exclude soft-deleted tombstones. (B12, B13)
* Sales Cycles: affiliate cost is now **every** non-void commission earned in the window (held-back balances used to vanish from the liability); `?start=2026-13-01` no longer 500s. (B14, B23)
* Resellers page: deleted accounts no longer listed; suspended badge + **Reinstate** button. (B15)
* Stock panel: settings save reports failures; hard-coded `$0.49` removed; dead "Reload now" / unused "Reload amount" removed (Geonode has no purchase API). (B16, B17)
* `reload-stock` / `sync-stock` / `record-benchmark` input validation and error handling. (B20, B21)
* Every admin button goes through `lib/adminFetch.ts`: no more `Bearer undefined`, no stuck spinners on network failure. Delete now needs the email typed (the old "Type OK" dialog couldn't take input). MFA-reset wording fixed (MFA is optional now). Users page no longer ships whole profile rows (payout details etc.) into a client component. (B25, B26, B31)
* Settings page webhook note lists the events actually handled. (B29)
* Concurrency/validation: `readJson` / `isUuid` on every rewritten route.

Closed by the concurrent Auth & MFA pass (`23900ce`), not re-done here: apply-reseller/affiliate status guards (my B7/B8 root cause), server-side admin password change (B24), `sendEmailSafe`.
Not changed: `debug-geonode` 401 (off by default; not distinguishing "not signed in" from "not admin" is fine).

## Feature gaps closed

* **Admin audit log** (`admin_audit_log` + `/admin/audit` + per-user "Admin activity" panel). Written by every state-changing admin route, plus system rows.
* **Affiliate lifecycle:** approve with explicit rates, **edit rates**, **suspend / reinstate** (previously impossible), suspended section, "Awaiting payment" vs "Accruing", "Recently paid" with reference and payer.
* **Suspending an account now shuts off live proxy traffic** (Geonode sub-user capped at what it has used; restored on reinstate) — previously it only blocked the dashboard. Per-credential **Disable / Enable** on `/admin/credentials` and the user page. Partial Geonode failures are reported, not swallowed.
* **Payment visibility:** Orders page shows refunded amount, invoice number, status filters (incl. "has refund"), customer search.
* **Pagination + search** on Users, Orders, Credentials (were hard 200-row / unbounded lists).
* Suspend reason prompt (stored, shown in the email); confirmations on irreversible actions; "Needs attention" counters on the Overview.

## Verified

* `tsc --noEmit` clean; `next build --webpack` passes; `check-schema-sync` OK through 0043.
* Real Postgres 16 with Supabase-style stubs and default privileges: full `schema.sql` loads with 0 errors; **old schema (`7654609`) + 0043** loads with 0 errors, is idempotent, and matches the fresh schema (only difference: column order). Behaviour tests (all pass): payout carry-over, below-minimum, no-method, hold, ineligible, re-run no-op, mark-paid idempotent + actor/reference, refund reduce/void/paid-audit/late-commission, stats and earnings aggregates, non-admin cannot self-grant Verified Operator / prev-rate / `mfa_enabled` / role, audit log RLS, and the RPC attack script (all service-only RPCs denied to a signed-in user).

## Not tested (be honest)

* Not run against live Supabase / Geonode / Paystack. The Geonode traffic-cap shutoff (`updateSubUserTrafficLimit` to current usage, floored at 1 MB) follows the same call the app already uses for top-ups, but **try it once on a throwaway account** (suspend → confirm the proxy stops → reinstate → confirm it resumes).
* UI was type-checked and built, not clicked through.
* Concurrency was reasoned about and enforced in SQL (atomic `UPDATE … WHERE status='pending'`, claim-then-size), not load-tested.

## After deploying — run these

```sql
-- 1. Is any SECURITY DEFINER function still callable by signed-in / anonymous users? Must return 0 rows.
select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef and p.prorettype <> 'trigger'::regtype
  and p.proname <> 'is_admin'
  and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));

-- 2. Commissions stranded by the old cycle logic. The NEXT payout run will now pay these.
select referrer_id, count(*), sum(commission_amount_usd)
from public.affiliate_commissions
where status = 'pending' and payout_id is null
group by 1 order by 3 desc;

-- 3. Possible past double-pays from the retired mark-commission-paid endpoint
--    (commission paid earlier than the payout that also included it).
select c.id, c.referrer_id, c.commission_amount_usd, c.paid_at as commission_paid_at, p.paid_at as payout_paid_at
from public.affiliate_commissions c join public.affiliate_payouts p on p.id = c.payout_id
where c.status = 'paid' and p.status = 'paid' and c.paid_at < p.paid_at - interval '1 second';

-- 4. If check (1) returned rows BEFORE 0042_api_integrations_hardening was applied, look for abuse that already happened:
--    bandwidth_accounts whose total_gb is not explained by orders / transfers / referral bonuses.
```

`mark-commission-paid/route.ts` is now a 410 stub so this package can be applied as a plain tar extract; you can `git rm` it.
