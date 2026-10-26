# Fix package — Section 7: Reseller, affiliates & payouts

Apply order: **run `supabase/migrations/0097_affiliates_payouts_pass.sql` in Supabase FIRST**, then push
(deploy.yml's migration gate). Idempotent; already folded into `schema.sql`.

| | What | Where |
|---|---|---|
| B1 | Bulk send retried the daily 50-new-recipient cap like a per-minute throttle (6 x 15s per row) and reported rows as "could not be confirmed". The API now tags that refusal (`code: new_recipient_limit`) and the sender reports it at once as a definite failure. | `api/reseller/allocate`, `ResellerUsersList` |
| B2 | Reversing a paid M-Pesa payout left the KES amount/rate on the pending row. Cleared. | `0097`, `admin_reverse_paid_payout` |
| B3 | Referrals page said "payout is created at the next run" when the $20 was only reached with this cycle's commissions, which the run does not take. Now uses payable minus this cycle. | `app/dashboard/referrals/page.tsx` |
