# GlobProxy — fix package 10 (post-audit)

Fixes for the remaining findings from the last review (bandwidth-summary
mislabeling was already fixed by you before this package — confirmed by
re-cloning; not included here).

## 1 & 2 — `profiles.email` had no source of truth

Two related gaps, one migration:

- **Never synced.** `handle_new_user()` only ever ran on INSERT into
  `auth.users`. When a user later changed their email through Supabase's
  normal email-change flow, `auth.users.email` updated but `profiles.email`
  was never told — admin panels, the confirmation emails in
  `lib/bandwidth.ts`, `reseller/allocate`'s recipient lookup, and the
  signup/reset dedupe checks all kept using the stale address indefinitely.
- **Never protected.** `protect_privileged_profile_columns()` pins `role`,
  `is_suspended`, `reseller_status`, `api_access`, etc. against direct
  client writes, but `email` wasn't in that list — any logged-in user could
  PATCH their own `profiles` row via a raw REST call and set `email` to
  anything, including another real user's address. The app's own UI never
  does this (`dashboard/settings` only ever sends `full_name`/
  `company_name`), so this was only reachable by going around the UI, but
  the DB should be the one enforcing it.

**Fix** (`supabase/migrations/0011_protect_and_sync_profile_email.sql`,
folded into `schema.sql` for fresh installs):
- New `AFTER UPDATE OF email ON auth.users` trigger (`sync_profile_email`)
  is now the only path that moves `profiles.email` post-signup — mirrors
  the existing `on_auth_user_created` pattern. It runs with `auth.uid()`
  null (no request JWT on an auth.users-triggered update), which is
  exactly the bypass condition `protect_privileged_profile_columns()`
  already grants service-role/trigger writes, so the two work together
  without any special-casing.
- `email` added to the pinned-column list in
  `protect_privileged_profile_columns()`.
- One-time backfill (`UPDATE profiles SET email = auth.users.email WHERE
  email IS DISTINCT FROM ...`) catches any drift that already happened
  before this migration ran.
- Case-insensitive unique index on `profiles(lower(email))` — every
  lookup in this app already queries by `.eq('email', x.toLowerCase())`
  and assumes one match; there was never a constraint actually
  guaranteeing that.

**Before you run this migration:** if the writable-email bug already let
two profiles collide on the same address, the unique-index step at the
end will fail with a duplicate-key error. If that happens:
```sql
select lower(email), count(*) from public.profiles group by 1 having count(*) > 1;
```
then fix/rename the colliding row's email and re-run just the last
`create unique index` statement.

## 3 — `dashboard/billing`'s cancel button lied on failure

`cancelOrder()` didn't check whether its `UPDATE` actually matched a row —
Supabase doesn't error on a 0-row update (RLS silently filtering, or the
order having already left `pending`), so a no-op and a real cancel both
came back as `{ error: null }`. Added `.select('id')` and a row-count
check, same pattern already used in `admin/suspend-user`,
`dashboard/proxies/[id]` DELETE, etc. — this file was just the one place
that missed it.

## 4 — webhook / verify-payment could credit a non-pending order

Both only ever checked `payment_status === 'paid'` to avoid double-crediting.
Neither checked that the order was still `'pending'` before crediting it —
so an order that had moved to `'cancelled'` (e.g. `api/checkout`
auto-cancels a user's other pending orders when they start a new checkout)
or `'failed'` (cron cleanup) could still get credited if Paystack later
fired `charge.success` for it, e.g. a stale checkout tab completed after
the order had already moved on elsewhere. Not a way to get bandwidth
without paying — `amountMatchesOrder` + server-to-server
`verifyTransaction` still require a real, matching payment either way —
but it left orders permanently mislabeled (showing `cancelled` in billing
history while the bandwidth was actually credited). Both routes now
require `payment_status === 'pending'` before crediting; anything else
logs and refuses.

## Database

One new migration to run: `0011_protect_and_sync_profile_email.sql`. See
the note above about the unique-index step if you've had this app live
for a while.
