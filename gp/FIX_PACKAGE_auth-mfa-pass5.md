# Auth & MFA — pass 5 (migration 0071)

**Apply migration `0071_auth_mfa_pass5.sql` before/with the deploy.** schema.sql is folded through 0071.
(Until it exists the app falls back to the old row shape and logs `apply migration 0071`; nothing breaks, but the device-revoke fix is inactive.)

## Gaps closed
- **Resend-confirmation no longer strands the password.** `/auth/verify` now takes the password again; with it the resend goes through the same PKCE signup path as the signup form (`signUp()` on the unconfirmed address, password replaced only after the mail provider accepted the link, metadata carried over), so the confirmed account keeps the chosen password. Without it the old `resend()` still works and the page says a "Forgot password" will be needed.
- **Signing a device out ends its 2FA trust.** `mfa_verified_sessions.auth_session_id` links each verified/trusted browser to its login session (set on verify, enrol, password change, and re-linked at every sign-in and email-link sign-in from a browser that already holds the cookie). `DELETE /api/auth/sessions` now removes the linked rows. A normal sign-out still keeps a trusted browser trusted (by design).
- **Email-link sign-ins are audited.** `/auth/callback` records a `login` event (`via`: recovery_link / email_change_link / email_link) and sends the new-device notice like a password sign-in.
- **Change email needs a fresh authenticator code for 2FA accounts** (same step-up as payout/API keys); accounts without 2FA keep the current-password check. The card uses `fetchWithReauth`.

## Bugs fixed
- **TOTP replay no longer counts as a wrong guess** (sign in, then a step-up with the same code in the same 30 s step). The slot is refunded and no `mfa_failed` is logged.
- **Email-change callback** says "applies once the other address confirms" while `new_email` is still pending, instead of "updated".
- **mfaGate** answers a verified-session lookup failure with 503, not `mfa_required` (also in `/api/auth/password`).
- **Current-password checks fail closed** if the throttle store errors, and are limited per account+connection (8/15 min) with an account-wide ceiling (40/15 min) that only unfamiliar connections hit — a stolen session on another network can no longer use up the owner's budget.
- **Account-wide sign-in pause** (new-location lock-out): a password reset by e-mail now lifts it (`loginacct`, `pwcheckacct`), and the lock-out message says so.

## Notes
- Not changed: the lock itself stays (it is what stops a botnet grinding passwords).
- Verify on staging: `email_change` double-confirmation relies on GoTrue keeping `new_email` set after the first link; resend-with-password relies on `signUp()` re-sending for an unconfirmed address (the signup form already depends on this).
