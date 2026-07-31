# GlobProxy audit fixes — round 3

Covers the last stretch: proxyEndpoint targeting, cron/stockStatus/email
libs, admin credentials/orders stat accuracy, and RLS on `orders`.

## What's in this round

**1. State/city silently dropped when country isn't set**
`buildProxyUsername()` only nests state/city into the connection string
inside `if (opts.country)` — so a request with `state` set but no `country`
got a completely untargeted, worldwide proxy with zero indication anything
was ignored. The dashboard form actively allowed this: the state/city inputs
rendered and accepted input regardless of country selection.

Fix, in two layers:
- `lib/proxyEndpoint.ts` gets a new `validateTargeting()` — used at every
  write path (dashboard proxy creation, v1 sub-user creation) to reject the
  combination outright instead of silently dropping it. `buildProxyUsername`
  itself is left as-is (still silently drops), since it's also used to
  *render* already-stored credentials (ProxyCard, SessionManager) — throwing
  there would crash the UI for any legacy row with this shape.
- `NewProxyForm.tsx` disables state/city until a country is picked, and
  clears them if country is cleared afterward, so a user can't get into this
  state through normal use in the first place.

**2. `sendEmail()` never checked whether Resend actually accepted the request**
No caller anywhere in the app — payment confirmations, suspension/reseller
notices, admin stock-exposure alerts, bandwidth threshold alerts — had any
way to know if an email failed. A misconfigured `RESEND_API_KEY` or a
rejected recipient would silently drop every email in the product. Now logs
`[email] send failed` with status/body on a non-2xx response.

**3. Admin credentials & orders pages undercounted past 200 rows**
Same pattern as the orders-page fix from round 1's README notes, now
actually fixed, plus a second instance found on the credentials page:
- `admin/orders/page.tsx` — revenue/GB-sold/paid-order-count now come from
  an unlimited, two-column query instead of the same 200-row-capped list
  used for the table.
- `admin/credentials/page.tsx` — total/active/pending counts now come from
  exact-count queries instead of the capped list.

**4. `orders` RLS let a client rewrite other columns while cancelling**
The "Cancel own pending order" policy only checks that the *final*
`payment_status` is `'cancelled'` — RLS doesn't restrict which columns an
UPDATE touches. A client could technically send
`{ payment_status: 'cancelled', amount_usd: 0.01 }` on their own pending
order and it would pass. Not profitably exploitable today — the amount
actually charged and GB actually credited both come from immutable Paystack
metadata set at checkout, not this row, so a mismatch just makes the webhook
refuse to credit — but it corrupts the order history for no reason. Added
`protect_order_columns` trigger (migration 0006), mirroring the existing
`protect_privileged_profile_columns` pattern already used on `profiles`: a
non-admin update can only ever flip `pending → cancelled`, every other
column is pinned to its previous value.

## Apply

```bash
cd globproxy/gp
tar -xzf ~/Downloads/globproxy-fixes-3.tar.gz --strip-components=1 -C .
git add .
git commit -m "fix: state/city-without-country silent drop, email send failures now logged, admin stat accuracy, orders RLS column lockdown

- validateTargeting() rejects state/city with no country at every write
  path instead of buildProxyUsername silently dropping them; dashboard form
  disables state/city until a country is picked
- sendEmail() now checks the Resend response and logs failures instead of
  every caller silently assuming success
- admin/orders and admin/credentials pages compute their header stats from
  unlimited/exact-count queries instead of the same 200-row-capped list
  used for the table, which silently undercounted past 200 rows
- add protect_order_columns trigger so cancelling your own pending order
  can only ever flip payment_status, not rewrite amount_usd/gb_amount/etc.
  in the same request"
git push
```

Run `supabase/migrations/0006_lock_down_order_columns.sql` in Supabase
first, same as every round before this.

## Noted but not changed (documented, not fixed)

- **Dead code in `activateBandwidth()`**: its "Step 4: Activate pending
  reseller transfers" queries `reseller_transfers` for `status = 'pending'`
  rows with a linked `credential_id`. Nothing in the current app ever
  creates a transfer that way — `POST /api/reseller/allocate` inserts
  transfers directly as `status: 'active'` with no credential, crediting the
  recipient's `bandwidth_accounts.total_gb` directly instead. This looks
  like it's from an earlier design (create-a-credential-then-transfer-it)
  that got replaced by the current simpler balance-transfer model, but the
  old activation code never got removed. It's inert, not harmful — just
  dead weight and a little confusing to read. Worth a cleanup pass whenever
  convenient, not urgent.
- **Cron's `runCleanup()` interacts with the same "cancel doesn't cancel the
  charge" tradeoff noted in round 2.** It marks pending orders older than 24h
  as `'failed'`. If Paystack's webhook is delayed past that window and
  arrives later, `activateBandwidth()` will still credit it — its only
  guard is `bandwidth_credited = false`, not `payment_status`. Same
  reasoning as before: not changing this, since blocking the credit would
  mean a customer who was genuinely charged gets nothing. Flagging it here
  so it's grouped with the other instance of the same tradeoff rather than
  looking like a new, separate bug.
- Skimmed the static terms/refunds pages — no code issues, didn't review the
  legal content itself (out of scope for a code audit).
- `sendAccountDeletionEmail()` in `lib/email.ts` is defined but never called
  anywhere — consistent with round 1's finding that the "delete user"
  feature has no working UI path to it at all.

## Files touched

```
lib/proxyEndpoint.ts                       (modified — validateTargeting added)
lib/email.ts                               (modified)
app/api/dashboard/proxies/route.ts         (modified)
app/api/v1/sub-users/route.ts              (modified)
app/dashboard/proxies/new/NewProxyForm.tsx (modified)
app/admin/orders/page.tsx                  (modified)
app/admin/credentials/page.tsx             (modified)
supabase/migrations/0006_lock_down_order_columns.sql  (new)
supabase/schema.sql                        (modified)
```

## That's the full pass

This closes out the systematic trace from auth through admin, including
dashboard sessions/billing/settings, the reseller clients page, cron tasks,
email, and RLS. If you want, I can go back through with fresh eyes on
anything specific — the frontend design/UX layer wasn't in scope here at
all, and I didn't fuzz inputs or write actual tests against any of this,
just read the code carefully.
