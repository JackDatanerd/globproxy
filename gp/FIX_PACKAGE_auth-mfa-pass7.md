# Auth & MFA — independent pass 7

An independent audit of section 2 (app/auth, app/api/auth, lib/mfa*, lib/email*, 2FA/session components),
done as if no earlier pass existed. Static review of the code and the SQL behind it, then fixes.
`npm run check` (schema sync, cron, API docs, supplier-leak ratchet, 58 tests, typecheck) passes.

**Apply `0082_auth_mfa_pass7.sql` before / with the deploy.** Until it is applied, "Change authenticator"
answers "temporarily unavailable" and an e-mail change does not end other sessions; every other flow works.

## Policy decisions (from the owner)
- 2FA is **required for administrators**; resellers and customers stay optional + recommended.
- A trusted ("remember 30 days") browser **survives a plain sign-out** (already landed in pass 6; unchanged here).

## Feature gaps closed
| # | What | Where |
|---|------|-------|
| G1 | **Change authenticator in place.** Prove the current factor (code, or a backup code if the old phone is gone) → scan a NEW seed → prove it → atomic swap. 2FA stays on throughout; other trusted browsers lose 2FA trust; owner is e-mailed. | `lib/mfa.ts` startRekey/confirmRekey, `app/api/auth/mfa/rekey`, `TwoFactorSettings`, migration 0082 (`pending_secret`, `mfa_rekey_start/confirm`) |
| G2 | **Durable security alerts.** 2FA enabled / disabled / authenticator changed / backup codes regenerated / lockout / sign-in throttled / new device are stored with `notify`, sent now, and retried by the existing `security` cron for 24 h. `sendEmailSafe` also retries once (429/5xx/network) with an idempotency key. | `lib/securityEvents.ts` (`recordAndNotify`), `lib/securityNotices.ts`, `lib/email.ts`, the 2FA routes, login, callback |
| G3 | **E-mail change ends every session and every 2FA-verified browser** (as password change already did). The session that confirms the change is created after, so the person stays signed in where they finished it. | migration 0082 (`on_auth_email_changed`) |
| G4 | **Location-aware new-device alerts.** Cloudflare country is stored on events; a country not seen in 180 days (once the account has any on record) counts as a new device. Activity list shows the country. | `recordLogin`, `lib/signInNovelty.ts`, `AccountSecurityCards` |
| G5 | **2FA required for admins**: middleware sends an unenrolled admin to setup from every signed-in area; admin layout and `authorizeAdmin` enforce it (fail-closed); the Disable button is hidden and `disableMfa` refuses for admins. | `middleware.ts`, `app/admin/layout.tsx`, `lib/adminAuth.ts`, `lib/mfa.ts`, mfa-setup page |
| G6 | Regenerated backup codes card: Copy + "I've saved these" gate before Done. | `TwoFactorSettings` |

## Bugs fixed
- **B2** Signup no longer answers differently when the e-mail provider is rate-limited (it let a visitor tell new from existing addresses, and the limit could be induced). Logged server-side instead.
- **B3** Per-account e-mail cap (`USER_EMAIL_RATE_LIMITER`) on 2FA-recovery requests and change-email; a correct password clears the password-check counters, so those alone didn't bound them.
- **B4** An email-change link opened on the wrong device gets its own message instead of the signup wording.
- **B5** "Resend confirmation" keeps the plan picked at signup.
- **B6** `mfa/recovery` and `mfa/browsers` no longer return raw `e.message` (`RecoveryUserError` marks user-safe text; the rest is logged and answered generically).
- **B7** Removed the dead `type=invite` callback branch (it dead-ended on a password prompt).
- **B1** (trusted browser vs sign-out) was already resolved upstream in pass 6; nothing changed.

## Tests
`tests/security-notices.test.mjs`: new-sign-in rules (device / country / legacy history) and the `sendEmailSafe` retry contract.

## Not changed on purpose
The 2FA lock stays per-account (a password-holder can pause code entry for 15 min; resetting the password by e-mail lifts it).
