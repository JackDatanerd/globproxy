# Fix Package 16 — silent read failures in MFA verification

## What the DevTools trail actually showed

Studio SELECT: `mfa_enabled = true`, `confirmed = true`, not locked. Clean
account, confirmed by fresh incognito session, clean payload
(`{"code":"900349"}`), and a genuinely live 400 response body:
`{"error":"Two-factor authentication is not set up on this account."}`

Those two facts contradict each other *unless* the app's own read of the
row is failing silently — which is exactly what's happening.

## Root cause

`getFactor()` in `lib/mfa.ts` — the function every MFA operation
(`verifyFactor`, `disableMfa`, `regenerateBackupCodes`, `confirmEnrollment`)
calls to check the real state — only ever destructured `data`, never
`error`:

```ts
const { data } = await supabase.from('mfa_totp_factors')...maybeSingle()
return (data as FactorRow) ?? null
```

If that query fails for *any* reason — bad/stale service-role credentials,
a transient network error, anything — `data` comes back `null`, which is
byte-for-byte indistinguishable from "this user genuinely has no factor
row." Every caller treats `null` as "not set up," which is exactly the
message you saw, on an account that is demonstrably fine at the database
level.

Two more spots in the same file had the identical shape:
`consumeBackupCode()`'s two Supabase calls, and `checkVerifiedSession()` —
plus a manually-duplicated copy of that last one in `middleware.ts`
(`hasValidMfaSession`), which gates *every* protected page load. If the
same underlying read is failing there, it would look identical to "your
12h session expired" on every single request — a standing, silent
mfa-verify loop with nothing anywhere pointing at why.

## Fix

- `getFactor()` and `consumeBackupCode()` now check `error` and throw a
  distinct, honest message ("Could not verify your account right now —
  please try again in a moment") instead of silently returning `false`/`null`.
  These run inside API routes that already catch and surface `e.message`,
  so this is a clean behavior change: infra failures now say so, instead
  of lying about enrollment state.
- `checkVerifiedSession()` (`lib/mfa.ts`) and `hasValidMfaSession()`
  (`middleware.ts`) stay **fail-closed** on error (still return `false`,
  still redirect to re-verify) — these run on page loads, not inside a
  try/catch, so throwing would surface as a hard error page instead of
  the existing graceful redirect. What changes is they now
  `console.error` the real reason before failing closed, so it's visible
  in your Cloudflare Worker logs (`wrangler tail`) instead of invisible.

This doesn't change what a genuinely-broken account sees today — it's
still going to fail. What it does is turn "the error text lied to us" into
"the error text tells us the truth," and puts the actual reason in your
logs the next time this fires.

## What I'd do next to actually unblock this account

This code fix alone won't get `tagod64176@gzeos.com` past Verify — it
makes the *next* failure diagnosable, but the underlying read is still
broken right now. To find out why, in order of how likely I think each is:

1. **Re-set `SUPABASE_SERVICE_ROLE_KEY` via `wrangler secret put`,
   even if it already "looks" set.** This matches your project's own
   established failure mode — the Cloudflare dashboard mangles special
   characters in secrets, and a mangled service-role JWT would explain a
   read that fails silently across the board while Studio (talking to
   Postgres directly, no service-role key involved) sees everything fine.
2. **Tail the Worker logs during a live failed attempt**
   (`wrangler tail`, or Supabase's own API/Postgres logs under Logs in
   the dashboard) to see the actual `error` object this fix now prints —
   that'll tell you definitively whether it's an auth/key problem, a
   timeout, or something else entirely, rather than guessing further.
3. Once the real cause is fixed, this account's own data doesn't need
   further repair — Studio already confirmed it's healthy; it just needs
   the app to actually be able to read it.

## Files changed

- `lib/mfa.ts`
- `middleware.ts`

## To apply

```
cd C:\Users\jackk\Desktop\MyWebApps\globproxy\gp
tar -xzf ~/Downloads/globproxy-fixes-16.tar.gz --strip-components=1 -C .
git add -A
git commit -m "fix: stop silently swallowing Supabase read errors in MFA checks — infra failures no longer masquerade as 'not set up'"
git push
```

No migration this time — app code only.
