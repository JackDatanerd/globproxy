# GlobProxy audit fixes — round 1 (critical/high items)

Fixes for the highest-severity items from the audit: the reseller
allocation/usage-sync conflict, the admin panel bypassing its own server
routes, and suspended accounts keeping working API access. Plus the smaller
race conditions and silent-failure bugs found along the way.

## 1. Run the migration first

In Supabase SQL Editor, run:

```
supabase/migrations/0004_reseller_allocation_and_race_fixes.sql
```

It's idempotent — safe to re-run. It:
- adds `bandwidth_accounts.allocated_gb` and repoints the generated
  `available_gb` column to account for it
- adds `allocate_reseller_bandwidth()` — atomic reseller→client transfer
- adds `credit_bandwidth()` — atomic payment credit
- adds the unique constraint the two functions' `ON CONFLICT` clauses need
  (already implied by the table def, this just makes sure it's actually there)

`supabase/schema.sql` is also updated to match, so a fresh install stays in
sync with production.

## 2. Apply the code changes

```bash
cd globproxy/gp
tar -xzf globproxy-fixes.tar.gz --strip-components=1 -C .
git add .
git commit -m "fix: reseller allocation race + admin route bypass + suspended-account API access

- separate bandwidth_accounts.allocated_gb from used_gb so the usage-sync
  cron stops erasing reseller allocations on every run
- make reseller bandwidth allocation atomic (allocate_reseller_bandwidth RPC)
  instead of a racy read-then-write with a buggy rollback path
- make payment bandwidth credit atomic (credit_bandwidth RPC)
- wire the admin panel's approve/reject/suspend/role-change actions through
  actual server routes instead of writing to profiles directly from the
  browser, so session-kill and notification emails actually run
- add is_suspended checks to all v1 API routes; add the missing
  role/api_access gate to /api/v1/account/bandwidth
- deleteSubUser() now checks the response instead of silently succeeding
  on failure
- proxy deletion now verifies a row was actually removed instead of
  trusting a silent RLS no-op
- fix case-sensitive email lookup in reseller allocation
- add randomness to Geonode sub-user usernames to avoid collisions in
  bulk-activation loops"
git push
```

## 3. Deploy

Same as always — push triggers the GitHub Actions deploy. Don't deploy this
one manually via `wrangler deploy` or the Cloudflare dashboard.

## What's NOT in this round

Two lower-severity items from the audit aren't fixed here — flag if you want
them next:
- Admin orders page (`app/admin/orders/page.tsx`) only sums the most recent
  200 orders for its revenue/GB-sold totals, so those numbers go quietly
  wrong past 200 orders. Needs a proper aggregate query instead of client-side
  reduce over a limited page.
- Email enumeration on `/api/auth/reset` and `/api/auth/signup` (distinct
  "no account found" vs generic error). Low severity, but a deliberate
  decision either way is better than the current default.

## Files touched

```
supabase/migrations/0004_reseller_allocation_and_race_fixes.sql   (new)
supabase/schema.sql                                               (modified)
lib/geonode.ts                                                    (modified)
lib/bandwidth.ts                                                  (modified)
lib/apiAuth.ts                                                    (new)
app/api/dashboard/proxies/[id]/route.ts                           (modified)
app/api/reseller/allocate/route.ts                                (modified)
app/api/v1/sub-users/route.ts                                     (modified)
app/api/v1/sub-users/[id]/usage/route.ts                          (modified)
app/api/v1/account/bandwidth/route.ts                             (modified)
app/api/admin/approve-reseller/route.ts                           (new)
app/api/admin/reject-reseller/route.ts                            (modified — now sends the rejection email)
app/api/admin/update-user/route.ts                                (new)
components/admin/AdminResellerActions.tsx                         (modified)
components/admin/AdminUserControls.tsx                            (modified)
```
