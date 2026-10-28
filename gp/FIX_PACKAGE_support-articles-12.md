# Support articles, bit 12: sign-in and password problems

New help article `cant-sign-in-forgot-password-reset-link-problems` (Guides, section: help), listed first under "Account security" on /help.

Covers: a message-to-fix table for sign-in errors, the 10-per-15-minute and account-wide sign-in pauses, resetting a password (1 h link, 30 min to finish, same-browser rule), reset email not arriving (4 per 10 min per address), "link no longer works", confirming a new account and resend (60 s cooldown, re-enter password), password rules (8 to 72 bytes, common and breached lists), changing a password in Settings, what to do if a password is compromised, and what to send support.

Checked against: app/auth/{login,reset,update-password,verify}, app/api/auth/{login,reset,password,resend-confirmation,sessions}, app/auth/callback, lib/{authThrottle,passwordPolicy,passwordCheck,targetThrottle,securityEvents,recoveryCookie}.ts and components/dashboard/AccountSecurityCards.tsx.

Files: gp/lib/blog/posts.ts, gp/lib/blog/help.ts, this note. No supplier name or "upstream" in the copy. tsc clean; 228/228 tests pass. Built on e3fc8d4.
