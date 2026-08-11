# GlobProxy — fix package 12 (pre-launch audit)

Fresh clone, full pass over the three commits since package 11
(`746ca03`, `1fc98e0`, `5bbbb36`). Everything those commits fixed was
re-verified in place and holds up under adversarial testing: delivery-time
SSRF re-check + `redirect: 'manual'` on webhooks, `requireActiveUser`
correctly wired on every write route (cross-checked all ~40 write-capable
API routes, not just the four named in the commit message), the Paystack
webhook signature check (constant-time compare, length-checked first), and
the atomic `claim_and_credit_order` transaction. All still correct, no
regressions.

Four findings from this pass — three real bypasses/gaps, one recurrence of
a finding from package 11's era. All four are fixed in this package.

## P0

**1. `schema.sql` drift — same finding recurring.**

`746ca03` regenerated `schema.sql` "through migration 0022." Migration
`0023_proxy_sessions_credential_ownership.sql` landed in the very next
commit and was never folded in. A fresh DB provisioned from `schema.sql`
alone shipped with the old `proxy_sessions` INSERT/UPDATE policies —
missing the `credential_id` ownership check 0023 added.

Fixed: `supabase/schema.sql`'s `proxy_sessions` policies now match 0023
exactly. Also added a real safeguard so this stops being a thing a human
has to remember:

- `scripts/check-schema-sync.mjs` — compares a manifest line at the top
  of `schema.sql` ("INCLUDES MIGRATIONS THROUGH: ...") against the actual
  newest file in `supabase/migrations/`, exits non-zero on mismatch.
- `.github/workflows/schema-drift-check.yml` — runs that script on every
  push and PR touching `gp/supabase/**`. Fails the build if they drift.
- `npm run check:schema` — same check, runnable locally before a push.

Next migration you add: update the manifest line at the top of
`schema.sql` when you fold it in, or CI will catch it and fail the push.

**2. SSRF guard bypass — NAT64 transition-form (`64:ff9b::/96`).**

`lib/ssrfGuard.ts` correctly caught the IPv6-mapped-IPv4 forms
(`::ffff:127.0.0.1` and the hex form `::ffff:7f00:1`) but didn't
recognize the NAT64 well-known prefix — the same address-embedding bug
class, just a different RFC. Confirmed by hand: `64:ff9b::7f00:1`
(encodes `127.0.0.1`) passed through as allowed.

Fixed: `extractEmbeddedIpv4()` now also strips the NAT64 prefix in dotted,
compressed-hex, and fully-expanded forms. Verified against 9 test cases
(all bypass forms now blocked, legitimate public IPs via NAT64 and normal
hostnames still pass — `64:ff9b::8.8.8.8` and `api.stripe.com` both
allowed as they should be).

## P1

**3. Webhook test endpoint rate limit — bypassable via multiple
endpoints.**

The cooldown added in `746ca03` was keyed per webhook-endpoint row, using
that row's own `last_success_at`/`last_failure_at`. Endpoint creation has
no URL-uniqueness constraint and an account can hold up to 10 endpoints —
so an account could create 10 endpoints all pointing at the same
third-party URL and round-robin test calls across them, each with its own
untouched cooldown clock. Reduced the "unthrottled POST to arbitrary URL"
problem by ~10x rather than closing it.

Fixed: the cooldown is now scoped to the account — it checks the max
`last_success_at`/`last_failure_at` across *every* endpoint the user owns,
not just the one being tested. Every test call from an account shares one
10-second clock regardless of how many endpoints exist. As a side effect
this also folds in real event deliveries (`deliverOne()` updates the same
columns), which is a feature, not a bug — real automatic deliveries and
manual test spam now share the same request budget instead of stacking.

**4. Timing side-channel remaining in the signup/reset enumeration
fixes.**

`5bbbb36` closed the status-code oracle on `auth/signup` and `auth/reset`
(both now return an identical response body for banned / already-exists /
suspended / brand-new). But both still branched on latency: the
short-circuit paths return after one or two fast `SELECT`s, while the
genuine-new-account path additionally waits on a real Supabase network
call (`signUp()` / `resetPasswordForEmail()`, both of which dispatch an
email). That gap is itself an enumeration oracle, just a timing one
instead of a status-code one.

Fixed: both routes now pad every exit to a shared floor (700ms for
signup, 500ms for reset — roughly the ballpark of the slow path) before
responding. Not a cryptographic guarantee — real network latency still
varies — but it collapses the gap from trivially measurable to buried in
normal jitter, which is the realistic bar for this class of mitigation.

## Files changed

```
gp/app/api/auth/reset/route.ts
gp/app/api/auth/signup/route.ts
gp/app/api/dashboard/webhooks/[id]/test/route.ts
gp/lib/ssrfGuard.ts
gp/package.json                              (added check:schema script)
gp/supabase/schema.sql                        (0023 folded in + manifest)
gp/scripts/check-schema-sync.mjs              (new)
.github/workflows/schema-drift-check.yml      (new, repo root — not gp/)
```

`npx tsc --noEmit` passes clean across the whole project with these
changes in place.

## Not green yet — one thing I couldn't verify from here

I regenerated `schema.sql`'s `proxy_sessions` policies by hand to match
migration 0023 exactly (diffed line-for-line against the migration), not
by running `supabase db reset && supabase db dump` against a live
Postgres instance — I don't have Supabase CLI/local Postgres access in
this environment. The SQL is correct as written, but you should still
run `check:schema` locally and eyeball the diff before merging, and treat
the manifest-line convention going forward as the actual regen trigger
rather than relying on a full dump each time.
