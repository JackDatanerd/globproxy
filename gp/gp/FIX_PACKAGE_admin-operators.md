# Admin & Verified Operators — independent pass 5 (migration 0073)

**Run `supabase/migrations/0073_admin_section8_pass5.sql` BEFORE deploying the code** (several routes call its functions/tables).
`supabase/schema.sql` is folded through 0073.

## Bugs fixed
1. API keys survive revoke_api_access / make_user and return on re-grant → keys are now revoked (`lib/adminAccountSecurity.ts`, `update-user`).
2. Full usage-sync cooldown checked an audit row written only after the sync ends → atomic `claim_admin_lock` / `release_admin_lock` (falls back to the old check until 0073 is applied).
3. `delete-user` / `cancel-invitation` wrote emails into the append-only audit log → no longer logged; existing ones scrubbed via `redact_admin_audit_details` (guard allows key REMOVAL only).
4. `delete-user` banned the sign-in account after releasing supplier sub-users → ban first, release second, ban undone if the release fails.
5. List pages (users, orders, credentials, resellers) showed a failed query as "no results" → `AdminQueryError` banner (+ user detail page).
6. `ban-email` looked for existing accounts by exact address → alias-aware `profiles_matching_ban`.
7. Support "resolved" email said "reply to this email" from a no-reply sender → `replyTo: support@globproxy.com`.
8. `mfa-reset` swallowed a failed session revoke → checked, audited and reported.
9. `grant-verified-operator`: stale-rate race on grant (guarded on the rates read); legacy operators with no recorded previous rates are asked which rates to restore instead of silently reset to defaults.
10. `clear-referral-flag` back-fill paid today's rate → `affiliate_rate_history`; `record_affiliate_commission` uses the rate in force at the earn time.
11. User detail page loaded every credential (`select *`, silent 1000-row cap) → newest 100 + true count + link.
12. Server did not refuse paying a suspended affiliate's payout (UI-only guard) → 409 `affiliate_suspended`, `overrideSuspended` to confirm; bulk never overrides.

(Withdrawn from the audit: "pending credentials of suspended accounts go live" — `claim_pending_credentials` already skips them since 0059.)

## Gaps built
1. Takeover response: `POST /api/admin/force-signout` (sessions + optional API keys + owner email) and a Sessions & API keys panel on the user page.
2. Payout reversal: `POST /api/admin/reverse-payout` (`admin_reverse_paid_payout`), "Reverse" button on paid payouts.
3. Support: reply to the customer (keep open) / resolve with a message; thread shown in the panel (`support_report_replies`).
4. Bans: Gmail dot/googlemail folding, `@domain` bans (mainstream providers refused), "also suspend accounts already using it" (shared `lib/adminSuspend.ts`).
5. `GET /api/admin/orders-csv` (+ filters/date range, step-up, audited) and an export control on the Orders page.
6. Overview tiles: paid-but-uncredited orders, refunds to confirm, failing scheduled tasks; Orders filter "paid, not credited".
7. Verified Operator: readiness/review panel (referrals, flagged %, 90-day sales/commission, voided, open deductions), `verified-operator-review` + 180-day review clock, "review due" badge on the affiliate list, stored rate history.
