# Section 2 — Auth & MFA: close-out round (pass 1 findings)

Apply order: **run `supabase/migrations/0045_auth_mfa_closeout.sql` in Supabase first**, then deploy.
(`schema.sql` already includes it; fresh installs need nothing extra.)

## Bugs fixed
| # | Fix |
|---|-----|
| B1 | `/api/auth/password` and `/api/auth/change-email` verified the current password on a throwaway client and then called `signOut()` — default scope is **global**, which ended every session of the user (the caller's own included, so the following `updateUser` likely failed). Now `lib/passwordCheck.ts` signs out with `scope: 'local'`. |
| B2 | `/auth/update-password` installed `access_token`/`refresh_token` from the URL hash (session fixation / login-CSRF: a crafted link signed the visitor in as the attacker and set the attacker's password to what the victim typed). Removed; `/auth/callback` now fails a code-less recovery link closed. |
| B3 | Account pre-hijacking: a signup for an unconfirmed address now **replaces** the stored password/metadata (newest signup wins) before the confirmation is re-sent, and uses `signUp()` (PKCE) instead of `resend()`. Password change on an unconfirmed account no longer raises a "password changed" event. |
| B4 | Key rotation could never finish: secrets encrypted under `MFA_ENCRYPTION_KEY_PREVIOUS` were never re-encrypted. `secretNeedsRewrite()` now flags them; they are rewritten on the next successful TOTP check. |
| B5/B6 | Enrollment/backup codes are atomic in SQL (`confirm_totp_enrollment_atomic`, `mfa_replace_backup_codes`); backup-code hashes are unique per user, not globally; start-enrollment cannot un-confirm a confirmed factor (`mfa_start_enrollment`); double-confirm race refused; if the verified-browser token fails after enrollment commits, the codes are still returned. |
| B7 | Infra error on the 5th (lock-setting) attempt now lifts the lock (`mfa_refund_attempt(.., p_was_last)`). |
| B8 | Enumeration timing: signup/reset/resend now cap the slow (email-sending) branch at the same floor as the fast ones (`lib/constantTime.ts`, floor 1.8 s, work continues via `waitUntil`). Signup no longer echoes GoTrue errors (only a 429 is surfaced). |
| B9 | "Recovery" session detection is the signed cookie only (the `amr` fallback accepted `otp`/`magiclink`, so confirming a signup/email-change skipped current-password + 2FA for 30 min). `gp_recovery` is cleared on sign-out. |
| B10 | Banned (deleted) accounts get the friendly message at login; `appUrl()` replaces raw `process.env.NEXT_PUBLIC_APP_URL` (no more `undefined/…` links — applied repo-wide); 2FA setup reuses the pending secret for 15 min (second tab no longer invalidates the QR); MFA routes use `requireActiveUser`; operator/config errors are no longer shown to users; deletion e-mail no longer claims the address was removed; `sendEmail` fails loudly without `RESEND_API_KEY` and sends a plain-text part. |

## Feature gaps closed
- **Password re-prompt ("sudo mode")** for accounts without 2FA: API-key create, webhook create/edit/delete/rotate, payout method, account deletion, turning on 2FA. `POST /api/auth/reauth` → `gp_sudo` cookie (10 min). Dashboard `apiFetch` shows a dialog and retries automatically. Accounts with 2FA are unchanged (TOTP step-up).
- **Trusted-browser list + per-browser revoke** (`/api/auth/mfa/browsers`, Settings → 2FA).
- **Active-device list + per-device sign-out** (`/api/auth/sessions`, Settings and Admin settings).
- **Per-account login throttle** (10 / 15 min per e-mail, one owner alert per window), per-account password-check throttle (8 / 15 min), common-password list + HIBP k-anonymity check (fail-open; `PASSWORD_BREACH_CHECK=off` disables), disposable-domain list expanded (90 domains + subdomains).
- **Signup policy enforced in the database** (`before insert on auth.users`: ban list incl. `+alias`, disposable domains) so direct GoTrue signups can't bypass it.
- **Supabase-native CAPTCHA pass-through** (see env below).
- **Security trail**: events + tripwire e-mails for API-key and webhook creation, trusted browsers, session revokes, account deletion; completed e-mail change notifies the **old** address (DB trigger); activity card keeps important events visible.
- **Self-service 2FA recovery** (lost authenticator *and* backup codes): password → e-mailed link → 48 h waiting period (cancel link in every e-mail, no sign-in needed) → removal. Page `/auth/mfa-recovery`, linked from the 2FA screen.
- **CSP in Report-Only mode** (`/api/csp-report` logs violations).
- 0044's payout-hold trigger now also restarts on `email_changed` and `mfa_recovery_completed`.

## Cross-section (traced): supplier name shown to customers
- Public API docs no longer mention `geonode_username`; v1 credential JSON no longer returns the `geonode_username` alias (**breaking for any integrator who used it — `username` / `connection_username` are unchanged**); dashboard proxies page no longer ships `geonode_*` keys to the browser.
- Not changed: the DB column names themselves (`proxy_credentials.geonode_*`) — only visible to someone querying PostgREST by hand; renaming them is a wide migration, say the word.

## Config / env
- `SUPABASE_CAPTCHA_ENABLED=true` — set **together with** Supabase Dashboard → Authentication → Attack Protection → CAPTCHA (Turnstile secret). Then GoTrue verifies the token itself and the routes stop calling siteverify.
- `PASSWORD_BREACH_CHECK=off` (optional).
- Keep `MFA_ENCRYPTION_KEY_PREVIOUS` until users have regenerated old backup codes (backup-code hashes are one-way).
- Recommended in Supabase: minimum password length 8+, rate limits, "Secure password change".

## Known limits (unchanged by design)
- 2FA is optional for everyone; the step-up is a cookie, not an `aal2` claim — a holder of a live session can still call GoTrue's `updateUser` directly (the DB triggers still revoke verified browsers and notify).
- Resend-confirmation can still e-mail the real owner a link for an account an attacker pre-registered; the password is only replaced when that owner (or anyone) signs up again.
- The login throttle can be used to pause someone's sign-in for 15 min (password reset still works).
