# GlobProxy — fix package 9

All 5 numbered findings (P0 #1-3, P1 #4-5) confirmed against a fresh clone
(HEAD `9f551e3`) and fixed, plus all 3 P2 items. Two things worth reading
before you deploy this one — #2 and #3 below are genuine judgment calls,
not just bug fixes.

## P0

**1. Suspended users could hit write APIs directly** — confirmed
`is_suspended` was missing from `checkout`, `dashboard/proxies` POST, and
both handlers in `dashboard/sessions/[sessionId]`; `middleware.ts`
explicitly excludes `/api` so page-navigation sign-out never covered these.
Added `requireActiveUser(userId)` — a new shared helper in `lib/apiAuth.ts`
— to all three, plus `reseller/allocate` (see below). Centralizing it as
suggested so future routes are less likely to miss it.

**2. `auth.admin.signOut(user_id, 'others')` was called with the wrong
argument type** — confirmed against `@supabase/auth-js`'s own type
signature: `signOut(jwt: string, scope?)` takes a session JWT, not a
user_id. Both call sites (`admin/suspend-user`, `admin/update-user`) always
failed silently.
- **`suspend-user`**: switched to `updateUserById(user_id, { ban_duration })`
  — `'876000h'` on suspend, `'none'` on unsuspend (reversible, unlike the
  permanent ban used for account deletion). This actually blocks new
  logins/refreshes, which combined with fix #1 means even a still-live
  token can't do anything meaningful until it expires within the hour.
- **`update-user`** (role/api_access changes): **removed the broken call
  instead of fixing it.** `ban_duration` would be wrong here — this isn't a
  suspension, the user should still be able to log in as whatever they now
  are. I checked whether anything in this codebase trusts a JWT-embedded
  role/permission claim instead of reading fresh from `profiles` (RLS
  policies, `requireApiAccess`, every `admin/*` route) — nothing does. A
  downgraded user's still-live session is already fully constrained by the
  new values the moment the update commits, so there was nothing this call
  was actually protecting even when it worked. **If you know of a code path
  I missed that does trust a stale JWT claim, flag it — that's the one
  scenario where this judgment call would be wrong.**

**3. Bandwidth reclaim via delete-then-recreate — the revenue leak, now
closed.** Confirmed: `release_credential_bandwidth()`'s caller
(`dashboard/proxies/[id]` DELETE) always released the full `gb_allocated`
regardless of `gb_used`. Buy 10GB → allocate a 10GB credential → use 9GB of
real traffic → delete (reclaims the full 10GB) → recreate: ~19GB extracted
from a 10GB purchase. Fixed by fetching **live** usage from upstream
(`getSubUserUsage`) *before* deleting the sub-user, and releasing only
`gb_allocated - usedGb`. Falls back to the last cron-synced `gb_used`
column if the live call fails, rather than blocking the delete. Updated the
stale "known follow-up, not addressed" comment in migration `0009` to point
here — **that file's content changed but its actual SQL logic didn't; no
new migration to run, nothing new to apply against Supabase.**

## P1

**4. `last_used_at` fire-and-forget promise could be silently cancelled**
by the Workers runtime once the response returns. Wrapped it in
`getCloudflareContext({ async: false }).ctx.waitUntil(...)` so the
invocation stays alive until it completes; falls back to the old
fire-and-forget behavior if not running in a Workers context (local dev).

**5. SOCKS5 integration snippets were silently wrong** —
`components/dashboard/ProxyCard.tsx`'s Python and Node snippets were
hardcoded to `http://` regardless of `cred.protocol`; only the curl
command and the Browser-extension label already branched correctly. Fixed
both to use `socks5h://` + the right library
(`requests[socks]` / `socks-proxy-agent`) when `cred.protocol === 'socks5'`.

## P2 — all three fixed

- **`reseller/allocate` suspension check** — the audit's framing implied
  only the recipient side was unchecked; I verified independently that
  **neither side** was checked. Added `requireActiveUser` for the sender
  and an `is_suspended` check for the recipient.
- **`approve-reseller` / `reject-reseller`** now return `409` if
  `reseller_status` isn't `'pending'`, instead of silently no-opping (and
  potentially double-emailing) on a re-click of an already-resolved
  application.
- **Cron usage-sync O(n²)** — `filter()` was calling `.find()` on the same
  array per item; the previous `gb_used` was already sitting right there on
  `cred` inside the same `map()` step, so the re-lookup was unnecessary.
  Flattened to a single pass.

## Database

Nothing new to run. The one migration file that changed
(`0009_fix_available_gb_double_count.sql`) only has an updated comment —
its actual `alter table` / `create or replace function` statements are
identical to what's already applied.
