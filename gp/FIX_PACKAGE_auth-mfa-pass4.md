# Auth & MFA — pass 4 (migration 0060)

**Apply migration `0060_auth_mfa_pass4.sql` before/with the deploy.** schema.sql is folded through 0060.

## Bugs fixed
- **Post-hijack via "newest signup wins"** — a password set while an address is unconfirmed is now quarantined when the account confirms (DB trigger) and handed back by `/auth/callback` only for a same-browser PKCE exchange. A link opened elsewhere still confirms the email; the owner then uses "Forgot password". Login notices say so.
- **MFA lockout DoS** — a password reset by e-mail now lifts the 2FA lock; the lockout message says so.
- **Admin "trust this browser" failed open** when the role lookup errored — now fails closed (short session).
- **Code consumed, then session creation fails** — session write retried 3x; a clear message if it still fails.
- **profiles.mfa_enabled vs factor table drift** — trigger keeps them in step; one-time repair included.
- Migration-number comments corrected (0043 -> 0045 / 0053).

## Gaps closed
- **Fresh step-up for enrolled accounts**: payout, API keys, webhooks, account deletion, 2FA enrol, admin mutations and admin CSV exports need a fresh authenticator/backup code (10 min), not only the 12 h / 30 d verified-browser cookie. The `gp_sudo` cookie is tagged `pw`/`totp`; the dialog adapts.
- **Admin Settings -> "Sign-in & 2FA configuration"** panel (encryption key, seed formats, admins without 2FA, Turnstile, email). Booleans/counts only.
- **Deletion PII purge**: sign-in history, audit trail (tombstone kept, IP/UA stripped), recovery requests, quarantined password. The self-service delete route now uses the shared `purgeAccountSecrets` instead of a drifted private copy.
- **Owner-bound 2FA seed encryption** (`enc:v2:`, user id as GCM AAD). v1/plaintext rows upgrade on next verification.

## Notes
- Rolling the code back after v2 seeds exist leaves those users unable to verify until redeployed — keep the new code deployed.
- Token-only 2FA-recovery cancel/status is by design (emailed secret token).
- Not changed: admin-initiated session revoke (low value; owners can already revoke their own sessions).
