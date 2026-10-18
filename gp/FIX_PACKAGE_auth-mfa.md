# FIX PACKAGE — Auth & MFA (fresh independent pass, Oct 2026)

Base: `b27d18c`. Section audited: `app/auth/*`, `app/api/auth/*`, `lib/mfa.ts`, `lib/email*.ts`, 2FA / session components.
Product decision applied: **MFA is optional for everyone** (admin + reseller included) — recommended, never forced.

## Deploy checklist (in this order)

1. **Run `supabase/migrations/0039_auth_mfa_hardening.sql`** in the Supabase SQL editor *before* deploying the code
   (the new code calls `mfa_begin_attempt` / `mfa_consume_totp`; without them every 2FA check fails closed).
   `schema.sql` is already synced through 0039.
2. Deploy.
3. Optional env vars (all safe to add later — nothing breaks without them):
   | Var | Effect |
   |---|---|
   | `MFA_ENCRYPTION_KEY` (`openssl rand -base64 32`) | TOTP secrets encrypted at rest (AES-GCM); new backup codes HMAC'd. Existing rows upgrade lazily on the next successful verify. **Never remove it once set.** |
   | `MFA_ENCRYPTION_KEY_PREVIOUS` | Rotation: put the old key here when changing `MFA_ENCRYPTION_KEY`. |
   | `TURNSTILE_SECRET_KEY` + `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Cloudflare Turnstile on signup / login / reset / resend. Site key is inlined at build time. |
4. In the Supabase dashboard: Authentication → also enable CAPTCHA/attack-protection if you want the *direct* Supabase endpoints covered
   (the anon key is public, so `/api/auth/login` can't stop someone calling Supabase's `/token` directly).
5. The Supabase-sent "password changed" template and ours will both arrive until you disable one (pre-existing note).

## Feature gaps closed
- **Optional MFA** end-to-end: middleware, 3 layouts, `requireMfaVerified` (now "step-up if enrolled"), status/enroll routes, copy, emails; dismissible `MfaRecommendBanner` (1 day for admin/reseller, 14 days for users).
- **Step-up on sensitive non-admin routes** for enrolled accounts: API-key create, webhook create/edit, proxy create, payout-method change, account delete, password change, email change.
- **Resend confirmation** (`/api/auth/resend-confirmation` + `/auth/verify` form); signup now silently re-sends for an existing *unconfirmed* address.
- **Return-to-page after login** (`?next=`, validated by `lib/safeNext.ts`).
- **"Trust this browser 30 days"** on the 2FA screen (never for admin).
- **Server-side password change/reset** (`/api/auth/password`): current password required (except via a fresh recovery/invite link), server password policy, revokes all other sessions + MFA verified browsers, notice email.
- **Change email** UI + route (current password + step-up + double confirmation + notice to old address).
- **Security activity** card (`security_events`) + "Sign out other devices".
- **Server-side login** (`/api/auth/login`): rate limit, Turnstile, suspended/deleted refusal, audit event, **new-device email**.
- Lockout notice email, `security_events` audit trail (incl. admin MFA reset with actor).
- TOTP secrets encrypted at rest; backup codes keyed-HMAC (legacy SHA-256 still accepted).
- Rate limits on login / MFA endpoints / resend / password / apply routes; optional Turnstile.

## Bugs fixed
| # | Bug |
|---|---|
| B1 | `profiles.mfa_enabled` was user-writable → password-only attacker could switch off step-up. Pinned in trigger; gates read the factor table. |
| B2 | MFA only guarded pages + admin routes; sensitive user API routes were open to password-only callers. |
| B3 | Lockout counter was read-modify-write → parallel guesses never tripped it. Now atomic reserve-before-check (`mfa_begin_attempt`). Tested: 40 parallel guesses → 5 admitted. |
| B4 | TOTP replay race → atomic compare-and-set (`mfa_consume_totp`). |
| B5 | Security emails fire-and-forget on Workers (could be cancelled) → awaited via `sendEmailSafe`. |
| B6 | Middleware failed open when the profile query errored → now 503 on protected paths. |
| B7 | Open redirect via `next` on mfa-verify / mfa-setup. |
| B8 | Signup "Try again" dead end; signup-link-in-other-browser showed a misleading "password reset" banner; signup timing floor was below real latency. |
| B9 | apply-affiliate/-reseller reset approved/suspended accounts to `pending` (stopping commissions); unbounded input; no rate limit. |
| B10 | Password-changed notice depended on the browser → DB trigger + cron sweep + immediate flush. |
| B11 | `mfa/status` hid query errors as "NOT ENABLED". |
| B12 | Backup code typed without hyphen burned lockout attempts; `maxLength=6` truncated pasted "123 456". |
| low | `startEnrollment` reset lockout; mfa-verify sign-out didn't revoke the MFA cookie; raw error messages on 500; unbounded `full_name`; dashboard layout skipped step-up for non-privileged roles. |
| extra | `schema.sql` defined `is_admin()` ~200 lines *after* the two `support_reports` policies that call it, so a fresh run silently failed to create them. Moved earlier. |

## Verified
`tsc --noEmit` clean · `next build --webpack` passes · `check-schema-sync` OK · migration + full schema applied to a real Postgres 16 with Supabase-style stubs (0 errors) · SQL behaviour/RLS/trigger/grant tests · unit tests for code parsing, redirect safety, password policy, encryption (+rotation, tamper), recovery cookie, `amr` check.

## Known limits (honest)
- Row-level security / direct PostgREST reads still don't know about our custom 2FA step-up (it is a cookie, not an `aal2` claim). Closing that fully means moving to Supabase-native MFA — a separate, larger migration.
- A 15-minute 2FA lock is per account, so someone holding the password can keep re-locking the owner out; the lockout email + audit event now make that visible.
- The DB password trigger also fires if GoTrue re-hashes a password on login after a bcrypt-cost change (rare, one-off): harmless extra notice.
- Not runtime-tested against live Supabase: GoTrue behaviour of `resend()`, and the `amr` method names used as a secondary recovery signal (the primary signal is our own signed cookie set in `/auth/callback`).
