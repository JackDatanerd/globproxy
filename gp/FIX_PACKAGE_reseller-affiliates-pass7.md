# Reseller, affiliates & payouts — pass 7 (independent audit, baseline 16d24f9)

Apply supabase/migrations/0080_reseller_affiliates_pass7.sql to the database BEFORE deploying (npm run check:migrations).

Bugs
- run_affiliate_payout_cycle: the post-claim re-check only caught net <= 0; a refund between the eligibility check and the claim could create a payout under the minimum. Now also enforces the minimum.
- Daily new-recipient limit (50) was two different budgets: invitations counted only invitations, registered clients were checked in TS (not atomic). Now one budget (reseller_new_recipients_24h), enforced inside allocate_reseller_bandwidth_tx and create_pending_reseller_transfer under the stock lock; the API maps it to 429.
- transfers-csv / users-csv had no rate limit (up to 50k / 20k service-role rows per call). Now limited.
- Role checks aligned: reseller settings (dashboard + v1) accept admin like every other reseller route; v1 GET allocations / clients now answer 403 reseller_required to non-resellers.

Feature gaps closed
- clear-referral-flag back-fill now announces what it paid (bandwidth_credited webhooks to both accounts + "referral converted" e-mail), like a normal conversion.
- Refund clawback of a referral GB bonus is queued (referral_bonus_reversal_events) and swept hourly: bandwidth_debited webhook (source referral_bonus_reversed, role referrer/referred) + e-mail to the referrer. Documented in webhookEvents + docs.
- Open invitations can be lowered (Reduce on Transfers page, POST /api/reseller/invitations/reduce, PATCH /api/v1/reseller/invitations/:id) without cancelling; difference returns to stock, expiry/reminders unchanged. OpenAPI + docs updated.
- M-Pesa affiliates see an indicative KES figure on the Payable tile (market rate, same basis as payment).
- Sidebar "Earnings" renamed "Stock & Activity" (the page tracks stock, not revenue).
