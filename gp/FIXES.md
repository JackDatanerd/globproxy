# GlobProxy — fix package 6

Both bugs from the Aug 1 audit confirmed against a fresh clone (HEAD
`edf294e`) and fixed. The minor gb_amount source-of-truth item fixed too.

## 🔴 Bug 1 — `available_gb` double-subtracted `used_gb`

`available_gb = total_gb - used_gb - allocated_gb`. `allocated_gb` reserves
a credential's *full* cap at creation and only releases it in full on
deletion; `used_gb` (cron-synced) is always a subset of that same
reservation for active credentials. Subtracting both double-counted —
confirmed the exact trace in the audit: buy 20GB, allocate a 10GB
credential, use 6GB of it → `available_gb` read `4` instead of the correct
`10`, sliding negative with more use. Verified both consequences in code:
`app/dashboard/proxies/new/page.tsx` redirects to `/dashboard/buy` whenever
`available <= 0`, and `app/dashboard/usage/page.tsx` displays the raw
(possibly negative) figure.

**Fix:** `available_gb = total_gb - allocated_gb` — `allocated_gb` alone is
the "committed" figure; `used_gb` is still tracked and reported, just not
subtracted a second time. Requires a real migration:
`supabase/migrations/0009_fix_available_gb_double_count.sql` — drops and
recreates the generated column, and updates the two Postgres functions
(`reserve_credential_bandwidth`, `allocate_reseller_bandwidth`) that inline
the same balance-check expression so they stay consistent.
`supabase/schema.sql` updated to match for fresh installs.

**Known follow-up, intentionally not addressed here:** deleting a
partially-used credential still releases its full `gb_allocated` back
regardless of `gb_used` — delete+recreate can currently let a user reclaim
GB they already consumed. That's a separate design question (how
consumption should be treated on deletion), left open per the audit's own
framing rather than folded into this fix.

## 🔴 Bug 2 — reseller signup was a dead end

Confirmed via full-repo grep: `intended_role` is written to Supabase auth
`user_metadata` at signup and read back *nowhere* — not in
`handle_new_user()`, not in `app/auth/callback/route.ts`, not anywhere
else. A user who signs up via "Apply to resell" completes the flow as an
ordinary `role: 'user'` account with no application on file, no error
shown.

**Fix:** `app/auth/callback/route.ts` now checks
`user_metadata.intended_role === 'reseller'` after a successful signup
confirmation. If the caller didn't ask for a specific `next` destination and
the user doesn't already have a role/application on file, it redirects to
`/dashboard/settings?apply_reseller=1` instead of `/dashboard`.
`app/dashboard/settings/page.tsx` now reads that query param and
auto-opens the existing application form (the one `apply-reseller/route.ts`
already handles correctly) instead of trying to submit an incomplete
application from the signup form itself, since signup never collected
country/phone/monthly-volume.

## 🟡 Minor — inconsistent gb_amount source in the webhook

`app/api/webhooks/paystack/route.ts` now selects `gb_amount` on the same
`orders` query it already runs for the amount-match check, and credits
that DB value instead of the Paystack-echoed metadata value — matching
`verify-payment/route.ts`. Not exploitable before (metadata is server-set
at checkout, not client-mutable) but now there's one source of truth
instead of two.

## Requires a database migration this time

Run `supabase/migrations/0009_fix_available_gb_double_count.sql` against
your Supabase project (SQL Editor, or however you normally apply
migrations) — the git command below does not touch your database.

## Verify after deploying

- Buy bandwidth, create a credential using part of it, confirm
  `available_gb` (Usage page "Remaining") reflects the correct remaining
  total-minus-committed figure, not something that dips as you use what
  you already paid for.
- As a reseller with some stock, allocate to a client and confirm the
  balance check still works correctly with real numbers.
- Sign up via `/auth/signup?role=reseller`, confirm the email, and confirm
  you land on Settings with the application form already open.
