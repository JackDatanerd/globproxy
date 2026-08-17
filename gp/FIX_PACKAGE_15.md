# Fix Package 15 — MFA enrollment confirm race (same bug class as 0024, other side)

## Your question, answered directly

**Why does this happen on an account that has 2FA?** It doesn't, really —
`profiles.mfa_enabled` says yes, but the actual TOTP factor row says
`confirmed = false`. Those two flags are supposed to move together and
didn't.

**If it didn't have 2FA, why did the Verify screen even appear?** Because
middleware only ever checks `profiles.mfa_enabled` to decide
mfa-setup vs. mfa-verify — it never checks the real factor. Since
`mfa_enabled` was (wrongly) `true`, middleware sent the account to Verify.
Verify then calls `verifyFactor()`, which *does* check the real factor,
finds it unconfirmed, and throws the error you saw. Two different signals
for "is MFA set up," out of sync — the screen and the error are each
correctly following their own signal, which is exactly why they
contradict each other.

## Root cause

This is the **same bug class you already fixed in migration 0024** —
just the confirm side instead of the wipe side. `confirmEnrollment()` in
`lib/mfa.ts` did two separate, non-atomic writes to finish setup:

```
1. UPDATE mfa_totp_factors SET confirmed = true ...   ← no error check
2. UPDATE profiles SET mfa_enabled = true ...          ← runs regardless
```

Write #1 had no `error` check at all. If it failed for any reason
(transient DB error, statement timeout), write #2 still ran unconditionally
and flipped `mfa_enabled` to `true` anyway. From the user's side, setup
looked completely successful — they even got backup codes and a working
session, since those run right after. The break only shows up later, once
that session's 12h MFA cookie expires and middleware routes them back
through Verify using the now-wrong `mfa_enabled` flag.

0024's own comment describes this exact dead end almost word-for-word —
it just closed it for `wipeMfa()` (disable / admin reset). `confirmEnrollment()`
had the identical unatomic shape and was never touched, so the same class
of account-lockout could still happen going forward. This account most
likely hit it via enrollment, not disable — 0024's one-time repair only
covered accounts stuck as of that migration.

## Fix

`confirm_totp_enrollment()` — a new atomic RPC, same pattern as `wipe_mfa`
(migration 0024) mirrored for the opposite direction. Both writes commit
in one transaction; if the factor update doesn't find a row, the whole
thing raises and rolls back, so `mfa_enabled` can never end up `true`
unless the factor genuinely is. `lib/mfa.ts`'s `confirmEnrollment()` now
calls this RPC and throws if it errors, instead of doing the two raw
writes inline.

**Data repair included:** the migration re-runs the identical repair
query from 0024 (safe, idempotent — it only ever lowers `mfa_enabled`
back to `false` for accounts with no confirmed factor, which sends them
to a real `/auth/mfa-setup` re-enrollment on their next request). This
picks up any account — including whichever one is in your screenshot —
that got stuck via this confirm-side race specifically since 0024 shipped.

## Files changed

- `supabase/migrations/0026_atomic_confirm_mfa_enrollment.sql` (new)
- `supabase/schema.sql`
- `lib/mfa.ts`

## To apply

```
cd C:\Users\jackk\Desktop\MyWebApps\globproxy\gp
tar -xzf ~/Downloads/globproxy-fixes-15.tar.gz -C .
git add -A
git commit -m "fix: atomic MFA enrollment confirm — same race class as 0024, confirm side"
git push
```

Run `0026_atomic_confirm_mfa_enrollment.sql` against Supabase. That's what
actually repairs the stuck account — the app-code change alone only stops
new ones from happening.
