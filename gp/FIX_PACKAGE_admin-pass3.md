# Admin & Verified Operators — pass 3 close-out

**Run migration `0067_admin_section8_closeout.sql` BEFORE deploying** (the admin affiliate pages call
`admin_affiliate_earnings(p_referrer_ids)`, which 0067 creates).

## Bugs
- **B1 dispute-outcome**: `won` is now conditional on the status that was read; a concurrent `lost` is never overwritten (409 instead).
- **B2 refund-order**: a timeout / dropped connection / 5xx from Paystack (`RefundOutcomeUnknownError`) no longer releases the in-flight claim, so a retry cannot refund twice. Only a clear Paystack rejection releases it.
- **B3 affiliate rates**: `validateAffiliateRates` (lib/rates.ts) caps hand-set rates at the Verified Operator rates (40% / 20%); used by approve-affiliate, set-affiliate-rates and the admin prompts.
- **B4 customer pause**: admin credential enable refuses a credential the customer paused (`suspended_reason = 'customer'`); admin pages label it "paused by the customer" (lib/suspendReason.ts) instead of "account deleted".
- **B5/B6** affiliate detail page: VO history rows have an `id` (React key); default rates come from lib/rates.ts, not literals.
- **B7** `Cache-Control: no-store` on every CSV export and `/api/admin/*`; affiliates page shows a banner when a query failed instead of a silent empty list.

## Feature gaps
- **G1** Verified Operator grant/revoke now require a reason (audit log + shown in the affiliate's VO history); affiliates page has a VO filter, search, and Active / VO / Pending / Suspended tiles.
- **G2** Affiliate detail page has the action buttons (approve/reject, grant/revoke VO, edit rates, suspend/reinstate).
- **G3** Account suspend/reinstate dispatch `session_suspended` / `session_resumed` per credential (`source: account`); admin per-credential actions send `source: admin`. Docs + webhook event catalogue updated.
- **G4** Migration 0067: `admin_audit_log` rejects UPDATE / DELETE / TRUNCATE (except the FK set-null action).
- **G5** Affiliates and resellers lists are paged/searchable and select only the columns they show; pending lists are capped with the real totals shown; `admin_affiliate_earnings` takes an id list (no 1000-row truncation); a full usage sync has a 60 s cooldown.
