# Dashboard UI — pass 2 (fresh independent audit)

Bugs fixed
- Reseller application country list (88 hard-coded names) now uses the shared ~210-country dataset; free-text fallback if it can't load.
- New-session form: hidden "use as default" checkbox could silently save a *disabled* default after auto-allocate was toggled off.
- Account-data export and session .txt download use `saveBlob`/`saveTextFile` (URL was revoked after 1 s).
- Bulk IP whitelist: descriptions over 100 chars are caught client-side with the offending line number.
- /dashboard/api-keys fails closed when the profile lookup errors.
- Usage page and chart include paused sessions (marked "paused"); copy corrected.
- Auto-recharge: settings can be saved while the rule is off.
- Sign-out: Supabase session is ended first; the MFA proof is only dropped if that succeeded.
- A11y: drawer scroll-lock + focus, refund dialog Escape + focus trap, ProxyCard tabpanel/aria-controls.

Features added
- New session: create 1–20 identical sessions in one submit (own allocation, numbered labels, per-request idempotency keys, partial-failure reporting).
- "Duplicate" on every session card -> /dashboard/proxies/new?from=<id> (targeting columns only, read under the customer's own RLS).
- "Refresh usage" on the Bandwidth tab (wires up the existing /api/dashboard/proxies/[id]/usage route that had no UI).
- Export URLs (scheme://user:pass@host:port) next to .txt/.csv on My Proxies.
- Billing history: status filter chips + "Show more" paging.

Not done (needs other sections)
- One-click pay with saved card (new money-moving route; belongs with payments/auto-recharge).
- Configurable usage-alert thresholds (needs a column + cron/email change).
