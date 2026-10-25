# Fix package — Section 8 Admin & Verified Operators (pass 2)

Run migration `supabase/migrations/0058_admin_section8_closeout.sql` in the Supabase SQL editor (idempotent).

## Bugs
- clear_referral_flag back-fill paid commission on gross after refunds -> now net, skips fully refunded orders; flag_confirmed_at cleared in the same statement (route's second write removed).
- Refund: blocked while the order has an open dispute; explicit amount always sent once any part was refunded (omitted only for an untouched full refund). (Double-submit lock was already fixed upstream via claim_refund_request.)
- M-Pesa markup: server rejects null / non-number instead of coercing to 0% (client already skipped blank).
- Deleted accounts keep no Verified Operator flag (anonymisedProfilePatch + one-off cleanup in 0058; rollback restores it).
- Deletion email no longer claims a full data wipe; failed auth ban is audit-logged and tells the admin proxy sessions were already released.
- CSV exports (payouts, audit log) require the full step-up even on GET (authorizeAdmin opts.stepUp); buttons prompt for password when needed.
- Bulk mark-paid: client sends 25 at a time, reports partial progress, safe to re-run.
- Audit email search: warns when the 200-account match cap is hit; export audit row records it.
- run-payout-cycle: defaults come from lib/referrals (same constants as Terms / affiliate dashboard).

## Gaps closed
- Verified Operator grant/revoke history on admin affiliate detail page.

## Supplier exposure
- Root supplier-*.json removed; generator scripts use neutral upstream-targeting.json (git-ignored).
- Dead routes removed: reload-stock, mark-commission-paid.
