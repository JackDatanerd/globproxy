# Section 7 — Reseller, affiliates & payouts: close-out (pass 2)

Base: origin/main @ ca0f02f. Run `supabase/migrations/0051_section7_reseller_affiliates_closeout.sql` (already folded into schema.sql).

## Feature gaps closed
- G1 Standard 1 GB referral bonus is now reversed on refund (trigger on orders; claws from both sides, never below unassigned GB; cannot be re-earned).
- G2 New admin drill-down `/admin/affiliates/[id]` (terms, masked destination + hold status, payouts, commissions, referrals). Linked from affiliates + flagged-referrals pages.
- G3 Admin overview "Flagged referrals" attention tile.
- G4 Clearing a referral flag back-fills missed commissions (rate chosen by the order's paid date) or the standard bonus.
- G5 Referrer gets one email when a referral converts (first commission / bonus). Never names the referred user.
- G6 Payout-method change is recorded as a security event (`payout_method_changed`, destination never logged).

## Bugs fixed
- B1 Reclaim could take GB the client bought/earned themselves → now only the unspent part of the transfer after later credits, 30-day window (`lib/reseller.ts`).
- B2 7-day re-apply cooldown counted from submission → `reseller_rejected_at` / `affiliate_rejected_at` stamped on rejection (pinned in protect trigger).
- B3 Account deletion left bank/wallet/M-Pesa snapshots on `affiliate_payouts` → scrubbed (+ one-time backfill for already-deleted accounts).
- B4 Dead `reverseCommissionForRefund` (called a non-existent RPC) and stale cron comment removed.
- B5 a) refund emptying a pending payout deletes the $0 payout; b) run-payout-cycle enforces payable date (explicit "pay early" override, audited); c) allocate route uses `appUrl()`; d) reseller roster/summary only expose usage of GB that reseller sent; e) payout-method route no longer returns raw DB errors, rejects cross-site; run-payout-cycle no longer returns raw RPC errors.

## Verified
tsc clean; schema-sync OK; full schema.sql loads in PGlite and 38 behavioural assertions pass (refund reversal, backfill rates, cooldown pinning, payout emptying, scrub, reclaim cap/window, roster scoping); migration re-runs cleanly.
No supplier name introduced in any customer-facing text.

## Not closed until
A fresh independent pass finds nothing.
