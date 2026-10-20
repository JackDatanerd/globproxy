# Section 2 — Auth & MFA: pass 2 (independent audit)

Apply order: **run `supabase/migrations/0050_auth_mfa_pass2.sql` in Supabase, then deploy immediately.**
(`schema.sql` already includes it.) Between the two steps, requests using the old
`geonode_*` column names fail.

## Feature gap closed
- **G1** `POST /api/auth/reauth` did not exist (lib + dialog were built, route never committed). Every
  account without 2FA was stuck on "confirm your password": it could not enable 2FA, create API keys,
  manage webhooks, change payout method or delete its account. Route added (rate limit, SQL password
  check, `gp_sudo` cookie 10 min; accounts with 2FA get a 409). Cookie cleared on sign-out and password change.

## Bugs fixed
| # | Fix |
|---|-----|
| B1 | Signup pre-hijack race: password was replaced BEFORE the new confirmation e-mail was accepted, so a rate-limited re-signup replaced it while the owner's old link stayed valid. Now `signUp()` first, then `auth_replace_unconfirmed_password()` (atomic, only while unconfirmed). `resend()` fallback removed. |
| B2 | `verifyCurrentPassword` signed in through GoTrue: always failed with Supabase CAPTCHA on, created a session per check, used the shared per-IP sign-in limit. Now `auth_verify_password()` (bcrypt in SQL). Fails closed. |
| B3 | 2FA step-up added to ~20 routes that lacked it: checkout, proxy topup/delete/patch/retry/sessions, whitelist (+bulk), auto-topup (both), billing details/export, referrals export, claim-referral, apply-affiliate/reseller/api-access, webhook test/redeliver/deliveries, usage history, proxy-session routes. |
| B4 | Supplier name visible to customers via PostgREST column names. `proxy_credentials.geonode_{sub_user_id,username,password}` renamed `upstream_*` (migration + 21 code files + schema.sql + index). |
| B5 | 2FA recovery: completion is one transaction (`mfa_complete_recovery`); a confirmed request expires 7 days after the wait ends; a new request can no longer cancel a confirmed one; confirm is an audit event; completing recovery and admin MFA reset sign out other sessions (`revoke_other_auth_sessions`). |
| B6 | Password change uses the admin API after our own verification, so Supabase "Secure password change" can't block sessions older than 24 h. |
| B7 | `account_deleted` event is written only after the deletion commits (was logged on every failed/502/repeat attempt). |
| B8 | Origin check (`rejectCrossSite`) on every `app/api/auth/*` POST/DELETE and delete-account (login CSRF / text/plain forms). |
| B9 | `/auth/callback`: the `type` query parameter alone no longer grants the e-mail-proof cookie; GoTrue's `recovery_sent_at` / `invited_at` must be recent. |
| B10 | Replayed TOTP says "already used"; re-verifying a browser replaces its old verified row; `sendEmail` 10 s timeout; `mfa-setup` no longer hangs in dev StrictMode; "password reset requested" security event. |

## Test first after deploy
1. Password reset end to end (B9 relies on GoTrue keeping `recovery_sent_at` after the link is used).
2. A non-2FA account: enable 2FA (password dialog -> QR), create an API key.
3. Change password from a session older than 24 h.
4. Signup twice quickly with the same address, confirm from the older e-mail (must fail / old link dead).

## Config
- Check Supabase Auth rate limits: server-side sign-in/sign-up calls all come from the Worker's addresses.

## Not changed (decisions / accepted)
- 2FA is still a cookie, not an `aal2` claim: a logged-in user can read `proxy_credentials` via PostgREST without 2FA. Needs an access-token hook + RLS; not built.
- Someone with the password can keep a user's 2FA locked by failing codes (lockout by design).
- Dashboard components using plain `fetch` on newly gated routes show the server's 2FA message rather than redirecting.
