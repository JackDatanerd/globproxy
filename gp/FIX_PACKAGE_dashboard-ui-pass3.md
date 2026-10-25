# Dashboard UI — pass 3 (independent audit, fixes + feature gaps)

Apply migration **0086_dashboard_ui_pass3.sql** in Supabase BEFORE deploying (the deploy gate checks it).

## Bugs fixed
1. DashSidebar: scroll lock released (and drawer closed) when the viewport grows past the md breakpoint while the drawer is open.
2. ProxyList bulk actions: a failed / rate-limited chunk no longer clears the selection; unfinished sessions stay selected, a 429 stops the loop with a clear message.
3. Overview: ReferralLinkCard now receives `suspended` (matches the Referrals page).
4. UsageHistoryChart: shows when the host/country breakdown hit its row cap (`breakdown_truncated`).
5. MfaRecommendBanner: dismissal is stored per account, not per browser.
6. A11y: label/htmlFor on AffiliateApplyForm + PayoutMethodForm inputs, aria-pressed on payout method toggles, aria-expanded on BillingDetailsForm.

## Feature gaps closed
- Saved-card one-click purchase: `GET/POST /api/checkout/saved-card` (step-up + Idempotency-Key + MFA/purchase-block checks, charge → verify → credit, pending when unsure) and a "Pay with •••• 1234" button on Buy Bandwidth.
- Configurable session usage alerts (default 80/95): `profiles.usage_warn_pct/usage_urgent_pct`, used by usageSync emails/webhook, the My Proxies banners and Settings.
- Proxy list sorting (newest, oldest, most used, closest to limit, least left, label).
- Bulk "Add GB" and "Change country" on `/api/dashboard/proxies/bulk-action` + UI (top-up capped at 10 per request).
- Link to /status on the Support page.
- Already closed by other sessions since the first read: support replies in the dashboard, chunked bulk pause/resume/delete.

## Not closable in code
- IP whitelist semantics (does a listed IP *restrict* or *bypass credentials*): the UI copy deliberately claims neither until verified with a live test against the supplier.
