# GlobProxy — fix package

Addresses all 18 issues from the code audit. One file per concern where
possible; most fixes are commented in-place with the "why", not just the
"what". This file is a manifest — safe to delete after review, it isn't
read by the app.

1. **Open redirect in `/auth/callback`** — `app/auth/callback/route.ts`
2. **Bandwidth over-allocation exploit** — `supabase/migrations/0007_reserve_credential_bandwidth.sql`,
   `app/api/dashboard/proxies/route.ts`, `app/api/dashboard/proxies/[id]/route.ts`, `app/api/v1/sub-users/route.ts`
3. **Broken reseller "Sub-users" roster** — `app/reseller/users/page.tsx`
4. **Password-reset user enumeration** — `app/api/auth/reset/route.ts`
5. **Disposable-email check bypassable via API** — `app/api/auth/signup/route.ts`
6. **`debug-geonode` live in production** — `app/api/admin/debug-geonode/route.ts` (now requires `ENABLE_DEBUG_ENDPOINTS=true`)
7. **Inconsistent admin auth patterns** — `app/api/admin/approve-reseller/route.ts`,
   `app/api/admin/reject-reseller/route.ts`, `components/admin/AdminResellerActions.tsx`
8. **`suspend-user` missing target-exists check** — `app/api/admin/suspend-user/route.ts`
9. **`GET /api/v1/sub-users` missing `connection_username`** — `app/api/v1/sub-users/route.ts`
10. **Divergent credential-creation failure handling** — `app/api/dashboard/proxies/route.ts` (now degrades to `pending` like `v1/sub-users`)
11. **Unescaped user input in HTML emails** — `lib/email.ts` (new `escapeHtml()`), applied in
    `app/api/admin/approve-reseller`, `reject-reseller`, `suspend-user`, `delete-user`,
    `app/api/auth/apply-reseller`, `app/api/cron/[task]/route.ts`, `app/api/user/delete-account/route.ts`
12. **Leftover `fix.mjs`** — deleted (not part of this archive — see note below)
13. **Plan pricing duplicated 3x** — new `lib/plans.ts`, consumed by `app/api/checkout/route.ts`,
    `app/dashboard/buy/page.tsx`, `components/PricingPlans.tsx`
14. **Dead `reserve_reseller_gb()` function** — `supabase/migrations/0008_drop_dead_reserve_reseller_gb.sql`, `supabase/schema.sql`
15. **Missing suspension check in layouts** — `app/dashboard/layout.tsx`, `app/reseller/layout.tsx`
16. **Misleading "GB returned on delete" copy** — resolved as a side effect of #2 (now factually true); no text change needed
17. **`user!.id` non-null assertions** — `app/dashboard/page.tsx`, `app/dashboard/proxies/page.tsx`,
    `app/dashboard/usage/page.tsx`, `app/reseller/users/page.tsx`, `app/reseller/earnings/page.tsx`,
    `app/reseller/transfers/page.tsx`
18. **Admin user list not filtering deleted accounts** — `app/admin/users/page.tsx`

## Required manual step (not in this archive)

`fix.mjs` at the **repo root** (one level above `gp/`) should be deleted —
it's a leftover script, not part of the app. `tar` can't delete files that
aren't in the archive, so remove it separately:

```
rm fix.mjs
```

## Database migrations

Two new migrations need to be applied to Supabase in order after extracting:
`0007_reserve_credential_bandwidth.sql` then `0008_drop_dead_reserve_reseller_gb.sql`.
Apply them the same way you've applied 0001–0006 (Supabase CLI / dashboard SQL editor).

## New environment variable

`ENABLE_DEBUG_ENDPOINTS` — optional, defaults to disabled. Only set to `true`
in environments where you want `/api/admin/debug-geonode` reachable.
