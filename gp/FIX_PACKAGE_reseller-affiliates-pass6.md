# Reseller, affiliates & payouts — pass 6

Independent audit of section 7 (app/reseller/*, api/reseller/*, lib/resellerAllocation, lib/referrals,
lib/payoutCycle, lib/markPayoutPaid, apply / payout-method / claim-referral routes, referrals UI and the SQL
behind them). Audited at 4628299, fixed on e9a5594. `tsc`, `check:fast` (schema, cron, api-docs, supplier,
43 tests) green. Migration 0078 applied to a scratch Postgres 16 and exercised with the cases below.

## Before you deploy
Run `supabase/migrations/0078_reseller_affiliates_pass6.sql` (idempotent; already folded into schema.sql).

## Bugs fixed
1. **Reclaim could take the client's own balance** (high). Committed GB is now attributed to the reseller's
   bandwidth first, oldest transfer first. Reproduced before (100 own + 5 gift, all 5 committed → 5 GB reclaimed
   from the client's own balance), blocked after; partial (3 of 5 uncommitted → 3 reclaimable) and FIFO across
   two transfers verified.
2. A demoted reseller's open invitations still delivered stock. Claims now require the reseller/admin role, and
   demoting cancels open invitations and releases the reserved stock (trigger).
3. "Next payout run" skipped a payable cycle nobody had run yet — now reads "Payable since … — created at the next run".
4. Suspended affiliates' link card promised GB nobody would receive.
5. A reminder that the e-mail provider rejected was counted and reported as sent. Now: 502, slot refunded
   (`refund_pending_reseller_reminder`).
6. Rollover e-mails ("earnings rolling over") went out for any balance > $0, every cycle; now only for balances
   at/above the minimum payout.
7. claim-referral lacked `rejectCrossSite` and a per-user limiter.
8. Transfers CSV and referral funnel paging had no id tiebreak.
9. Transfers page showed "No transfers yet" on a query error / out-of-range page.
10. Hold banner showed after the payout method was removed; claimed invitations counted twice against the
    50-new-recipients budget.

## Feature gaps closed
1. Invitation e-mails link to `/auth/signup?email=…&invited=1`; the signup page prefills and explains.
2. M-Pesa payouts record KES amount + rate (`payout_local_*`): indicative KES in the pending table, a KES prompt
   (prefilled) on single mark-paid, market rate on bulk; shown to the affiliate, in e-mail, in both CSVs.
   (Market rate, not the checkout rate with markup. No estimate shown if M-Pesa checkout is switched off.)
3. Referrals marked "under review" per row, with how to appeal.
4. Unused reseller-sent GB returns to the reseller when the client deletes their account (inside
   `scrub_affiliate_data`, after upstream release/settle). No e-mail is sent to the reseller; the transfer shows
   as reclaimed.
5. Affiliates can cancel their own pending payout (`POST /api/dashboard/cancel-payout`, step-up, e-mail + audit).
6. Each payout shows its commissions and refund deductions (`my_payout_breakdown`).
