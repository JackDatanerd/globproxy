# GlobProxy — fix package 11 (pre-launch audit)

Fresh clone, full pass — every `app/api/*` route, `middleware.ts`, all `lib/`
files, all 11 migrations + `schema.sql`, and the dashboard components
touched by the last UI pass. Everything from fix packages 9 and 10 was
re-verified in place and is correct (suspension checks, atomic bandwidth
reservation, the delete-then-recreate reclaim fix, webhook/verify-payment
pending-status guards, `signOut`→`ban_duration`, email sync/protection
trigger, cron O(n²) fix, row-count checks on updates/deletes — all present,
all still correct, no regressions).

One new finding, not caught by packages 9 or 10 — **P0, fix this before
launch.**

## P0

**1. Security-definer RPC functions had no execute-grant restriction —
any logged-in user could call them directly  and bypass every
ownership/role check the app code relies on.**

`credit_bandwidth`, `allocate_reseller_bandwidth`,
`reserve_credential_bandwidth`, `release_credential_bandwidth`,
`bulk_update_credential_usage` are all `security definer` — they bypass
RLS by design, that's how they get atomicity without a round trip through
the RLS-gated REST path. None of them ever had `EXECUTE` restricted.
Postgres grants `EXECUTE` on new functions to `PUBLIC` by default, and
Supabase's own default project setup extends that to `anon`/`authenticated`
via `ALTER DEFAULT PRIVILEGES` — so, as shipped, any signed-up user could
open the browser console and call these directly via `supabase.rpc(...)`:

- `credit_bandwidth(p_user_id, p_gb)` — mint free bandwidth into *any*
  account, no payment required. The worst of these: a direct, trivial
  revenue bypass, worse than the delete-then-recreate bug fixed in package
  9.
- `allocate_reseller_bandwidth(p_reseller_id, p_recipient_id, p_gb)` —
  never checks the caller actually owns `p_reseller_id` or is a reseller
  at all (that check only lives in `reseller/allocate/route.ts`'s
  application code) — drain real GB out of any account into one you
  control.
- `bulk_update_credential_usage` — rewrite `gb_used` on any credential row
  by id, no ownership check.
- `reserve_credential_bandwidth` / `release_credential_bandwidth` — move
  *any* other user's `allocated_gb` directly.

Confirmed these two are genuinely called from the browser's own session
client (`app/api/dashboard/proxies/route.ts` and `.../[id]/route.ts` use
`createClient()` — anon key + user JWT — not the admin client), so
`authenticated` needs real access to them; the fix there is an
`auth.uid() = p_user_id` check inside the function itself (migration
0012), not a blanket revoke. The other four are only ever called from
server code via `createAdminClient()` (service_role) —
`reseller/allocate`, `lib/bandwidth.ts`, `lib/usageSync.ts` — so those are
now `service_role`-only.

**Fix** (`supabase/migrations/0012_lock_down_rpc_grants.sql`, folded into
`schema.sql` for fresh installs):
- Ownership check added to `reserve_credential_bandwidth` and
  `release_credential_bandwidth`.
- `REVOKE ALL ... FROM PUBLIC` on all six functions, then `GRANT EXECUTE`
  back to exactly the roles that need it.
- `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` /
  `GRANT ... TO service_role` — closes this for the *next* security-definer
  function someone adds, so this doesn't quietly reopen with the next
  migration.

## Also fixed (minor, found in the same pass)

**2. `schema.sql` was not actually a complete fresh-install reference.**
It was missing the `proxy_sessions` table (migration 0002), the `api_keys`
table (migration 0005), and `reserve_credential_bandwidth` /
`release_credential_bandwidth` / `bulk_update_credential_usage` /
`recalculate_bandwidth_accounts` entirely (0007/0009/0010) — someone
folding in later migrations' *edits* to existing functions (0009's
`available_gb` fix, for instance) never went back and added the functions
those migrations originally introduced. A fresh Supabase project bootstrapped
from `schema.sql` alone, as the file's own header instructs, would be
missing the sessions and API-keys features entirely and would 500 on every
credential creation (`reserve_credential_bandwidth` wouldn't exist).
Doesn't affect your live project — migrations 0002–0010 are presumably
already applied there — but it's a real gap if you ever spin up a fresh
project from this file (staging, DR, etc.). Regenerated `schema.sql` to
include everything through migration 0012.

**3. `dashboard/proxies/[id]/sessions` POST was missing the suspended-user
check.** Same category as package 9's P0 #1, just added after that sweep —
creating a new sticky session under an existing credential is a write and
wasn't covered. Doesn't consume new bandwidth (the parent credential
already reserved it), but a suspended user shouldn't be able to create new
working endpoints either. Added `requireActiveUser`.

**4. `AdminStockPanel.tsx`: manual reload and auto-reload amount shared
one input state.** A parallel independent review caught this — confirmed
by reading the source directly, not taken on faith: `reloadAmt` backed
both the one-time "Manual reload" GB field and the persisted
`auto_reload_amount_gb` setting under "Auto-reload alerts." Typing a
number into either field and then triggering the *other* action (a manual
reload, or "Save settings") silently overwrote the other value with
whatever was sitting in the shared field. Low-impact today —
`auto_reload_amount_gb` isn't consumed anywhere yet — but a real
correctness bug that'll bite once it is, and confusing regardless. Split
into `manualReloadGb` and `autoReloadAmount`.

Also swept the rest of `components/admin/` while there
(`AdminResellerActions.tsx`, `AdminUserControls.tsx`,
`AdminSyncUsageButton.tsx`) — all clean, route through the correct
server endpoints with Bearer auth, no issues found.

## Database

**One new migration to run: `0012_lock_down_rpc_grants.sql`.** Run this
before anything else in this package — it's the one that actually closes
the exploit. Safe to run against the live DB: every `revoke`/`grant`/
`create or replace function` is idempotent.

`schema.sql` was also regenerated for fresh installs — no action needed
against your live project, that file only matters the next time you
bootstrap a new one from scratch.

## Verified clean, no changes needed

Re-confirmed, fresh eyes, no assumptions from prior packages: `checkout`,
`webhooks/paystack`, `verify-payment` (signature verification, amount
matching, pending-status guards — all correct), `middleware.ts`
(suspension sign-out, admin/reseller gating), `auth/callback` (open-redirect
guard on `next`), `auth/reset` (no account-enumeration), `auth/signup`
(server-side email validation, banned-email/existing-account checks,
`intended_role` confirmed to never reach `profiles.role` — it's UI-redirect
metadata only, no privilege-escalation path), all `admin/*` routes (role
checks, suspend/unsuspend via `ban_duration`, delete-user's upstream-cleanup-
before-cascade ordering), `reseller/allocate` (sender+recipient suspension,
self-transfer guard, atomic RPC), `v1/*` API routes (`requireApiAccess`
gating, ownership-scoped queries), `dashboard/api-keys` (hash-only storage,
plaintext shown once), `user/delete-account` (upstream cleanup, ban-not-
delete to avoid cascading the anonymised tombstone), all RLS policies and
column-protection triggers in `schema.sql`, `lib/upstream.ts` (port mapping,
username-suffix targeting format, bulk usage pagination against the
Workers subrequest cap), `lib/proxyEndpoint.ts` (targeting validation,
state+city-together format), dependency list (small, current, nothing
flagged). No `dangerouslySetInnerHTML`, no `eval`, no client-side secret
leakage anywhere in `app/`/`components/`.

## Follow-up: display formatting consistency

Separate from the fixes above — raised after a screenshot review flagged
`ProxyCard.tsx` showing "0.1 / 0.05 GB · 100%" on a session row, which
reads as used-exceeding-allocated. Traced it back: it's a display bug, not
a data bug. `gbUsed` was rounded to 1 decimal while `gbAllocated` printed
raw/unformatted right next to it — for a credential sitting at ~0.0501 GB
used against a 0.05 GB allocation (basically fully used), that rounds to
"0.1" next to "0.05" even though the real numbers are sane and the 100%
figure is correct. Same root cause behind "0.9 GB" vs "0.92 GB" for the
same `available_gb` value on different pages — every page had picked its
own `toFixed()` depth independently, with no shared convention.

Added `lib/format.ts` — `formatGb()` (2 decimals, canonical) and
`formatPct(used, total, decimals)` (clamped to 100, matching what every
progress bar already does for its width — a few percentage *labels* had
forgotten to clamp the same way the bar next to them did, which would've
shown e.g. a full red bar next to "142%"). Applied across every GB/percent
display in the app: `ProxyCard.tsx`, `dashboard/usage`, `dashboard/proxies`,
`dashboard/page.tsx` (which had the same value at two different
precisions on one page), `dashboard/billing`, `reseller/users`,
`reseller/earnings`, `ResellerUsersList.tsx`, and the admin pages
(`admin/users`, `admin/users/[id]`, `admin/orders`, `admin/page.tsx`,
`admin/resellers`, `admin/credentials`, `AdminStockPanel.tsx`).
`NewProxyForm.tsx` was already consistently at 2 decimals throughout —
left untouched.

No behavior change beyond display — every underlying value, calculation,
and API response is exactly what it was; this only changes how numbers are
rounded on screen. `tsc --noEmit` and `next build` both clean.


## Apply

```powershell
cd C:\Users\jackk\Desktop\MyWebApps\globproxy\gp
git checkout -b fix-package-11
```

Extract the tarball at that repo root (paths match, `--strip-components=1`
works fine on this tarball — see earlier note), then:

```powershell
git add -A
git commit -m "fix: lock down security-definer RPC grants (P0), complete schema.sql, suspend-check on session creation, split reload-amount state, standardize GB/percentage display formatting"
git push
```

**Run `0012_lock_down_rpc_grants.sql` against your live Supabase project
before you ship** — that's the one that actually closes the exploit. It's
idempotent, safe to run as-is.

