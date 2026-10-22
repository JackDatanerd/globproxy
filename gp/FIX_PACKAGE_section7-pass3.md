# Section 7 — Reseller, affiliates & payouts — audit pass 3 close-out (migration 0066)

Apply `supabase/migrations/0066_section7_reseller_affiliates_pass3.sql` (already folded into `supabase/schema.sql`).
Deploy the app after the migration (new RPCs are called by the new code).

## Feature gaps closed
1. **Refund clawback after payout** — `affiliate_adjustments` ledger; a refund on an already-paid commission records a (cumulative) negative adjustment that the next payout cycle nets against new commissions. Affiliates see it on their referrals page and by e-mail; admins can waive it.
2. **Admin undo** — void one commission (`/api/admin/void-commission`), or flag+confirm a referral and void everything it earned (`/api/admin/void-referral-earnings`); paid money becomes a clawback, never a negative balance owed in cash. Buttons on Admin → Affiliates → affiliate and Admin → Referrals.
3. **Invite-and-claim** — allocating to an address without a confirmed account reserves the stock, e-mails an invitation, and the GB lands when the address confirms (claimed in the database on confirmation). Cancel (stock returns at once) or 30-day expiry. Works for the dashboard and `POST /api/v1/reseller/allocations` (`status: "pending_signup"`).
4. **Per-campaign-tag clicks** — `record_referral_click(code, sub)`, `my_referral_tags`; tag table on the affiliate's referrals page.
5. **Payout-day reminder** — hourly `resellers` cron task e-mails the admin on the 20th / 5th (once per cycle).
6. **Affiliate e-mails** — payout queued, payout voided, commission reduced/clawed back after a refund, deduction waived.
7. **Reseller extras** — low-stock alert setting + e-mail, clients CSV export, invitations in the transfers CSV, remove saved payout method. (Webhook on reclaim was already added by the API pass.)

## Bugs fixed
- allocate / reclaim / cancel-invite now require step-up (`requireStepUp`: 2FA, or password re-auth for non-2FA accounts); the UI answers the prompt.
- Self-referral: every signup's (IPv6-/64-collapsed) IP hash is recorded; a referral is flagged when it shares an address with the referrer's own signup, not only with their other referrals.
- Re-signup over an unconfirmed address replaces the earlier attribution.
- `credit_referral_bonus` refuses an order already refunded below the qualifying minimum.
- Bank-details "unchanged" check compared jsonb key order — re-saving identical details restarted the 48h hold.
- Bulk allocation: per-line `Idempotency-Key`, waits out the 30/min limiter, only failed lines are left in the box, unknown outcomes are listed (never auto-resent).
- Commission intro-rate window uses the order's paid time, not when the (possibly retried) credit ran.
- Dynamic © year in e-mails; `apply-api-access` cross-site guard; claim-referral form hidden after a purchase; suspended affiliates keep seeing their history and payouts.
- Account deletion purges the signup-address hash and closes the reseller's open invitations.
- Already fixed by other sessions and verified: deleted-affiliate payouts, payouts-csv truncation, API-access cooldown, duplicate payout constants.

## Cron
`custom-worker.ts`: `invites` added to `*/5`, `resellers` added (first) to the hourly entry; both registered in `lib/cronHealth.ts`. No wrangler change (same cron patterns).
