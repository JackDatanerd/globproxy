# Auth & MFA — independent pass 3

Apply `supabase/migrations/0053_auth_mfa_pass3.sql` BEFORE (or together with) deploying the code.

## Feature gaps closed
- **G1** Signup with an address that already has an account now emails that address ("you already have an account", or a "closed account" note). Response shape/timing unchanged; capped at 2 per address per hour; suspended accounts get nothing. (`signup/route.ts`, `auth_account_state`, `sendSignupExistingNotice`)
- **G2** Open 2FA-recovery requests are cancelled by: a successful 2FA sign-in, disabling/wiping 2FA, re-enrolling, admin reset. `mfa_complete_recovery` refuses when there is no confirmed factor. Settings shows a "Two-factor removal in progress" banner with **Cancel removal** (`recovery` route actions `pending` / `cancel_mine`, 2FA-gated).
- **G3** Admin routes that change state now require a full step-up (2FA, or a password re-confirmation for admins without 2FA). `adminPost` prompts for the password and retries, and redirects to 2FA verify on `mfa_required`. `mfa-reset` also checks the caller is active.
- **G4** New activity events `mfa_verified` and `mfa_failed`; the activity card shows the 3 latest of each routine kind.
- **G5** Backup codes ≤3: warning in Settings; ≤2 after a backup-code sign-in: email.

## Bugs fixed
- **B1** Login throttle no longer locks the owner out: hard limit is per account **and connection**; an account-wide ceiling (40/15 min) alerts the owner and then only lets connections the account has signed in from before keep trying.
- **B2** "Where you're signed in" now shows the visitor's real IP/browser (`login_sessions`, recorded at login and email-link sign-in) instead of the server's.
- **B3** Sign out (topbar, 2FA screen) is `scope: 'local'` — no longer ends every device.
- **B4** `sessions` GET/DELETE, `signout-others`, `mfa/browsers` GET/DELETE require an active account and a 2FA-verified browser.
- **B5** Lazy TOTP-secret re-encryption is best-effort; a failure can no longer turn an already-consumed correct code into an error.
- **B6** Email-changed notice failures now requeue (previously silently dropped).
- **B7** `gp_recovery` / `gp_sudo` signing fails closed if `SUPABASE_SERVICE_ROLE_KEY` is missing.
- **B8** Callback: recovery proof window 2 h → 65 min; unused `invite` branch removed.
- **B9** Plain-text email decoding order fixed (`&amp;` last).

## Deploy checklist (outside the code)
- `MFA_ENCRYPTION_KEY` set in production (otherwise TOTP secrets are stored unencrypted).
- Supabase Auth: "Secure email change" ON; enable the setting that requires the current password / recent sign-in for password changes — direct calls to GoTrue with a stolen session bypass the app's step-up otherwise.
