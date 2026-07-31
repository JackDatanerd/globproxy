# GlobProxy audit fixes — round 2

Covers the rest of the systematic pass: dashboard sessions/billing/settings,
the reseller "Clients" page, admin resellers page, and — the big one — the
"API Keys" page, which wasn't backed by a real API key system at all.

## What's in this round

**1. Real API keys (new `api_keys` table + full rewrite of key auth)**
The API Keys dashboard page was displaying the user's live Supabase session
`access_token` labeled as if it were a durable API key. That token:
- expires roughly hourly (it's a session JWT, not a key), so anything built
  against it broke silently within about an hour
- was a full session-equivalent credential, not scoped to API use
- had no revocation mechanism independent of signing out everywhere
- didn't even match the `gp_••••••` prefix format shown in the masked field

This round adds:
- `api_keys` table (migration 0005) — stores only a SHA-256 hash of each
  key, never the plaintext
- `POST /api/dashboard/api-keys` — generates a real `gp_live_...` key,
  returns the plaintext exactly once
- `GET /api/dashboard/api-keys` — lists keys (prefix/label/last-used only)
- `DELETE /api/dashboard/api-keys` — revokes a key immediately
- `lib/apiAuth.ts` rewritten to authenticate v1 API requests against this
  table (hash lookup) instead of `supabase.auth.getUser(token)`
- `ApiKeysClient.tsx` rewritten to create/list/revoke real keys instead of
  just displaying the session token

**This is a breaking change for the API surface.** Any existing integration
built against a copied session token will need to generate a real key from
the dashboard and swap it in — those tokens were never going to keep working
past their session lifetime anyway.

**2. Two more "silent no-op" fixes (same pattern as round 1)**
`DELETE /api/dashboard/sessions/[sessionId]` had the identical issue as the
proxy-delete route from round 1 — no `.select()`, so a blocked RLS delete
returned `{ success: true }` with nothing actually removed. Fixed the same way.

**3. Regression fix for round 1's `allocated_gb` migration**
Two pages were computing a reseller's "available" bandwidth as
`total_gb - used_gb` in JS — the exact formula that migration 0004 moved off
of. After that migration these would have silently shown an inflated
available balance (ignoring GB already committed via `allocated_gb`):
- `app/admin/resellers/page.tsx`
- `app/dashboard/reseller/users/ResellerUsersPage.tsx` (the "Your Clients" page)

Both now read the DB's `available_gb` generated column directly, same as
everywhere else already did.

## Apply

```bash
cd globproxy/gp
tar -xzf ~/Downloads/globproxy-fixes-2.tar.gz --strip-components=1 -C .
git add .
git commit -m "fix: real API keys, two more silent-delete no-ops, allocated_gb display regression

- add api_keys table and real gp_live_ key generation/revocation, replacing
  the API Keys page's display of the live session JWT as a fake 'key'
- rewrite lib/apiAuth.ts to authenticate v1 API requests against hashed
  api_keys instead of treating the bearer token as a Supabase session JWT
- fix silent no-op on DELETE /api/dashboard/sessions/[sessionId] (same
  missing .select() pattern as the round-1 proxy-delete fix)
- fix admin/resellers and dashboard/reseller/users 'available stock' figures
  to read available_gb from the DB instead of recomputing total_gb - used_gb,
  which went stale the moment migration 0004 introduced allocated_gb"
git push
```

Run the SQL migration (`supabase/migrations/0005_api_keys.sql`) in Supabase
**before** pushing this code — same reasoning as round 1: the routes assume
`api_keys` already exists.

## Noted but not changed

- **"Cancel order" doesn't cancel the underlying Paystack charge.** It only
  relabels the local `orders` row. If Paystack's webhook fires after a user
  cancels (a delayed/retried webhook, or they'd already submitted payment),
  `activateBandwidth()` will still credit it — its only guard is
  `bandwidth_credited = false`, not `payment_status`. I didn't change this:
  blocking credit on a "cancelled" order that was genuinely charged would
  mean a customer paid and got nothing, which is worse. Flagging so it's a
  deliberate decision rather than an accident — worth deciding whether
  "Cancel" should also attempt to void the Paystack transaction, or just be
  relabeled as "Hide" for abandoned pending orders.
- Didn't get to: `lib/proxyEndpoint.ts` in detail, the other cron tasks
  (stock sync, 80%/95% bandwidth alert emails), `lib/email.ts` and the full
  event list, `admin/credentials/page.tsx`, `admin/page.tsx` overview stats,
  RLS on `reseller_transfers`/`orders` specifically, and the static
  terms/refunds pages. Say the word and I'll keep going.

## Files touched

```
supabase/migrations/0005_api_keys.sql                    (new)
lib/apiAuth.ts                                            (rewritten)
app/api/dashboard/api-keys/route.ts                       (new)
app/api/dashboard/sessions/[sessionId]/route.ts           (modified)
app/admin/resellers/page.tsx                              (modified)
app/dashboard/api-keys/ApiKeysClient.tsx                  (rewritten)
app/dashboard/reseller/users/ResellerUsersPage.tsx         (modified)
```
