# Support articles — bit 7: Two-factor authentication guide

Built on `e1d2af2`. Only `lib/blog/posts.ts` changes. No migration, no env change.

## Article added (Guides)
- `two-factor-authentication-setup-backup-codes-recovery` — "Two-Factor Authentication: Set Up, Backup Codes and Getting Back In" (~6 min, 7 FAQs).
- Covers: enable (Settings → Enable two-factor authentication → scan → Verify & enable → save 10 codes), sign-in and "Trust this browser for 30 days", wrong-code/lockout (5 attempts, 15 min), using and regenerating backup codes, Change authenticator (new phone), removing trusted browsers, Disable, and the lost-phone-and-codes recovery (email link 1 h, 48 h wait, 7 day window, cancel routes).
- Every on-screen label, email subject and constant quoted was asserted against the code. No supplier name, no "upstream". Description 151 chars, title 67.

## Checks
tsc clean, supplier-leak ratchet OK, 157 tests pass.

## Observations (NOT fixed; for when the repo is quiet)
- The recovery flow sends no email when the 48 h wait ends (only on request and on start). The article tells customers to note the time. A "ready" email would be a small, optional improvement.
- The recovery start page and the in-code comment use the wording "I lost my authenticator AND my backup codes", while the verify page link reads "Lost your authenticator and your backup codes?" — harmless, article uses the on-screen one.
