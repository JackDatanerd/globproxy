# GlobProxy — fix package 4

Verified and fixes all 7 catalogued bugs plus both "worth a look" items from
the follow-up audit. Confirmed against the actual codebase (not taken on
faith) — see the audit writeup in chat for what was checked and how.

1. **Reseller applications silently never reach admin** — `app/api/auth/apply-reseller/route.ts`
   now writes `reseller_status`/`reseller_application` via the admin client.
   `protect_privileged_profile_columns` (schema.sql) force-resets
   `reseller_status` on any non-admin-client write, so the previous
   session-client update always no-opped that column with no error.

2. **Account deletion cascade + orphaned Geonode sub-users** — both
   `app/api/admin/delete-user/route.ts` and `app/api/user/delete-account/route.ts`
   now (a) call `deleteSubUser()` on every live credential *before* touching
   any local rows, and (b) ban the auth account (`ban_duration: '876000h'`)
   instead of calling `auth.admin.deleteUser()`. Deleting the auth user
   cascades through `profiles -> bandwidth_accounts/orders/proxy_credentials/
   api_keys/proxy_sessions`, wiping the anonymised tombstone you just wrote
   and throwing a raw FK error for any account with `reseller_transfers`
   history. Banning revokes access without any of that.

3. **Unescaped name in bandwidth-ready email** — `lib/bandwidth.ts` now
   imports and applies `escapeHtml()` to `full_name`, matching every other
   email call site in the app.

4. **`v1/sub-users` POST dropped `sticky_duration`** — now destructured from
   the body, passed to `createSubUser()`, and persisted on the row, matching
   the dashboard route's behavior.

5. **Auto-reload settings were a dead feature** — the stock-check cron
   (`app/api/cron/[task]/route.ts`) now reads `auto_reload_enabled` /
   `auto_reload_threshold_gb` from `platform_settings` and uses that
   threshold instead of `STOCK_ALERT_THRESHOLD` when enabled. Note:
   `auto_reload_amount_gb` is still unused — there's no automatic Geonode
   purchase pipeline in this codebase, so this only wires up the *alert*
   half of "auto-reload," not automatic purchasing. That would be a
   separate feature if you want it.

6. **Dead pending-transfer activation path** — removed the step-4 block in
   `lib/bandwidth.ts` that scanned for `reseller_transfers` rows with
   `status: 'pending'`. `allocate/route.ts` is the only writer of that table
   and always inserts `status: 'active'` with no `credential_id`, so the
   block could never match a row.

7. **Bandwidth alert threshold vs. reported figure mismatch** — the percent
   used in `runBandwidthAlerts()` (`app/api/cron/[task]/route.ts`) is now
   computed from `available_gb` instead of `used_gb`, matching the figure
   the email actually reports. Previously an account could sit with
   near-zero `available_gb` (heavy `allocated_gb`) and never cross the
   `used_gb`-based threshold.

## Also fixed (from "worth a look")

- **Paystack webhook** (`app/api/webhooks/paystack/route.ts`): added an
  explicit early return when the order lookup fails, instead of silently
  falling through to `activateBandwidth()` and relying on its atomic claim
  as an implicit safety net.
- **Password reset** (`app/api/auth/reset/route.ts`): `redirectTo` is now
  checked against your app's own origin (`NEXT_PUBLIC_APP_URL`) before being
  passed to `resetPasswordForEmail`, as defense-in-depth alongside Supabase's
  own project-level redirect allow-list.

## No database migration needed

Everything here is application code — no new columns, no new tables.

## Verify after deploying

- Submit a reseller application from a non-admin test account and confirm
  it actually shows up in `/admin/resellers`.
- Delete a test account that has at least one active proxy credential and
  confirm (a) the Geonode sub-user is gone on Geonode's side, (b) the
  `profiles` row still exists with `is_deleted: true`, and (c) the banned
  account can no longer log in.
