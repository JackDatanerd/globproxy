# GlobProxy — fix package 5 (includes package 4)

You hadn't applied package 4 yet, so this bundles both rounds. If you'd
already run package 4's git command before this one, re-running it here is
harmless — every file is just written to its final state either way.

## Round 4 (original 7-bug catalogue + 2 "worth a look" items)

1. Reseller applications silently never reached admin — `apply-reseller/route.ts`
   now writes through the admin client (the session-client write was
   silently reverted by `protect_privileged_profile_columns`).
2. Account deletion cascade / orphaned Geonode sub-users — both delete
   routes now clean up live Geonode sub-users first, then **ban** the auth
   account instead of deleting it (deleting cascades and destroys the
   anonymised tombstone + throws an FK error on `reseller_transfers` history).
3. Unescaped `full_name` in the bandwidth-ready email — `lib/bandwidth.ts`
   now applies `escapeHtml()`.
4. `v1/sub-users` POST silently dropped `sticky_duration` — now passed
   through and persisted.
5. Dead auto-reload settings — the stock-check cron now reads
   `auto_reload_enabled`/`auto_reload_threshold_gb` from `platform_settings`.
   `auto_reload_amount_gb` is still unused — no auto-purchase pipeline exists.
6. Dead pending-transfer activation block removed from `lib/bandwidth.ts`
   (allocate/route.ts never writes a matching row).
7. Bandwidth alert threshold now computed from `available_gb` to match what
   the alert email actually reports (was `used_gb`, which diverges under
   heavy `allocated_gb`).
8. Paystack webhook: explicit early return on a failed order lookup instead
   of silently falling through.
9. Password reset: `redirectTo` now validated against `NEXT_PUBLIC_APP_URL`'s
   origin before being passed to Supabase.

## Round 5 (this pass — new findings)

10. **Dead duplicate reseller-clients page deleted** —
    `app/dashboard/reseller/users/{ResellerUsersList,ResellerUsersPage}.tsx`
    had no `page.tsx` and were imported nowhere. The real routed page is
    `app/reseller/users/page.tsx`, using a *different* file,
    `components/reseller/ResellerUsersList.tsx`. Confirmed dead, deleted.
11. **`verify-payment/route.ts` documented** — genuinely has no auth check,
    confirmed safe in practice (reference-scoped, server-verified with
    Paystack directly, idempotent via `bandwidth_credited`), and now says so
    in a comment instead of looking like an oversight. No rate limiting
    added — nothing else in the app has any rate-limit infra, so bolting it
    onto just this route would be inconsistent rather than genuinely safer;
    flagged as a future defense-in-depth item if that infra ever gets built.
12. **`auth/signup/route.ts`'s `emailRedirectTo` origin-validated** — same
    fix pattern as the reset route in round 4, applied here for consistency.
13. **`purchaseBandwidth`/reload-stock confirmed as an intentional stub** —
    `lib/geonode.ts` throws a documented "not implemented" error (no
    documented Geonode purchase endpoint exists yet), and
    `reload-stock/route.ts` already surfaces that as a clean 501. Not a bug.
    No code change.

## Files this archive deletes (not just modifies)

- `app/dashboard/reseller/users/ResellerUsersList.tsx`
- `app/dashboard/reseller/users/ResellerUsersPage.tsx`

These aren't in the archive at all — the git command below removes them
with `rm -rf` before extracting, since tar has no built-in way to delete a
file that no longer exists in the new tree.

## No database migration needed

Everything in both rounds is application code.
