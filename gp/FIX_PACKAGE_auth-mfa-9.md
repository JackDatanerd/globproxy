# FIX PACKAGE — Auth & MFA (independent pass 9)

Base: `e168ca2`. Section: `app/auth/*`, `app/api/auth/*`, `lib/mfa.ts`, `lib/email*.ts`, 2FA / session components.

## Deploy order
1. **Deploy the code first.** It works both before and after the migration.
2. **Then run `supabase/migrations/0101_auth_mfa_pass9.sql`** (idempotent). Running it before the code
   breaks the old build: the security-activity card goes empty and /dashboard/referrals fails.

## Fixed
- **B1** Payout destination columns (`payout_wallet_address`, `payout_mpesa_phone`, `payout_bank_details`) are no
  longer selectable with a user's own token (column-level grants on `profiles`). `/dashboard/referrals` reads them
  through the service role and still shows masked values only.
- **B2** `security_events` no longer readable from the browser (policy dropped). New 2FA-gated
  `GET /api/auth/security-events` feeds `SecurityActivityCard`; `actor_id` and raw `meta` are never returned.
- **B3** `resend-confirmation` resets a squatter's referral after replacing the password (as `signup` does) and
  re-attributes only from the visitor's own referral cookie.
- **B4** reset / signup / mfa-recovery pages recover from a thrown fetch instead of sticking on "loading".
- **B5** login re-arms the captcha after a network error.
- **B6** "Sign out other devices" redirects an unverified session to the 2FA prompt.
- **B7** `validateEmail` + `enforce_signup_policy` + `enforce_email_change_policy` refuse trailing-dot /
  invisible-character domains (previously they dodged the disposable list). `normalize_ban_email` untouched
  (it backs an expression index).

## Rules this introduces
- `profiles` is column-granted. A migration that adds a `profiles` column MUST also run
  `grant select (col) on public.profiles to authenticated;` (tests/auth-mfa-pass9.test.mjs enforces it).
- User-session code must not `select('*')` from `profiles` or select the three payout columns.

## Verified
181/181 tests, `tsc --noEmit`, check:schema / api-docs / supplier. Migration exercised against PostgreSQL 16
(before/after probe of grants, policy and both trigger functions); not run on a live Supabase instance.
