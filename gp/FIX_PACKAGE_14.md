# Fix Package 14 — pre-launch audit fixes

## Audit scope

Cloned the repo fresh, re-checked auth/ownership on the dashboard, whitelist,
API-key, admin, and webhook routes, re-verified Paystack signature checking
(HMAC-SHA512, timing-safe compare, amount cross-check), reviewed
middleware's MFA gating, and swept for `dangerouslySetInnerHTML`/`eval`
usage (the one `dangerouslySetInnerHTML` — QR SVG rendering — is
library-generated, not user input, and already documented as such). No new
issues found in those areas; the four items below are the ones you flagged.

## 1. "Used" going missing after deleting a session with consumption

**What was wrong:** `used_gb` is computed live as `SUM(gb_used)` over
*active* `proxy_credentials`. Deleting a session correctly returns the
*unused* portion of its allocation to Available (fixed in an earlier
round — see migration 0009's own notes), but the *consumed* portion just
falls out of that sum on the next cron recalculation. It's not returned to
Available, and it's not credited anywhere else — it silently disappears
from Total, Used, and Available alike, which is exactly the "math looks
broken" symptom you saw.

**Fix:** migration `0025_archive_used_gb_on_delete.sql` adds a durable
`archived_used_gb` column to `bandwidth_accounts` and an
`archive_credential_used_gb()` RPC. The DELETE route now calls it with the
same `usedGb` value it already computes for the release calculation (one
snapshot, both numbers — can't drift apart), and
`recalculate_bandwidth_accounts()` folds the archive into `used_gb` instead
of letting it reset. `schema.sql` is updated and its migration manifest
line bumped — verified against `scripts/check-schema-sync.mjs` locally, it
passes.

**Needs a migration run** — this one doesn't just drop in as app code.

## 2. Sticky sessions had no quick-copy

**What was wrong:** the header-level quick-copy button (⧉, next to the
usage bar in the collapsed row) was hard-gated to `!isSticky`, because
`endpoints` was always `[]` for sticky credentials. Rotating sessions got
one-click copy; sticky sessions required opening the card and the
"Sticky sessions" tab every time.

**Fix:** `ProxyCard.tsx` now builds one ad hoc sticky endpoint the same
way rotating endpoints are already built on the fly (stickiness lives in
the connection username's lifetime/session suffix, not in anything that
has to be pre-registered), and the quick-copy button shows for sticky
sessions too. The managed "Sticky sessions" tab (create/pin/label/persist)
is untouched — this only adds the fast path for "just give me an endpoint."

## 3. Reseller calculator margin never moved

**What was wrong:** `sell = buy + 2.20` — a fixed markup riding on top of
whatever tier `buy` landed on, so "Margin per GB" read the same at every
volume. Also `buy`'s tier prices were hardcoded here separately from
`lib/plans.ts`, the exact duplication that file's own header comment
warns about.

**Fix:** `buy` now reads from `lib/plans.ts` tiers directly, and `sell` is
pegged to the Micro tier's real retail price (what GlobProxy itself
charges, and roughly what a reseller's own customers would expect to pay)
instead of trailing `buy`. Margin now genuinely widens at higher volume —
the actual incentive the calculator is supposed to demonstrate.

## 4. "$4.50" homepage copy read as a per-GB floor

**What was wrong:** "Start from $4.50 →" is correct (Micro plan total,
not per-GB), but with no context nearby it can read like a per-GB price
floor, which contradicts the $2.00/GB Scale rate shown elsewhere on the
same page.

**Fix:** both CTA buttons (hero + closing section) now pull the number
from `lib/plans.ts` instead of a hardcoded string, and each has a small
caption underneath: "$4.50 total to get started · as low as $2.00/GB at
scale." No pricing changed — just removed the ambiguity where it would
land.

## Files changed

- `supabase/migrations/0025_archive_used_gb_on_delete.sql` (new)
- `supabase/schema.sql`
- `app/api/dashboard/proxies/[id]/route.ts`
- `components/dashboard/ProxyCard.tsx`
- `components/ResellerCalc.tsx`
- `app/page.tsx`

## To apply

```
cd C:\Users\jackk\Desktop\MyWebApps\globproxy\gp
tar -xzf ~/Downloads/globproxy-fixes-14.tar.gz -C .
git add -A
git commit -m "fix: archive consumed GB on session delete, sticky quick-copy, reseller calc margin, homepage pricing clarity"
git push
```

Then run migration `0025_archive_used_gb_on_delete.sql` against your
Supabase project (SQL Editor or your usual migration path) — app code
alone won't pick this one up.
