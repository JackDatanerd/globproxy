# GlobProxy — fix package 7

All 8 findings from the Aug 2 "findings only" audit confirmed against a
fresh clone (HEAD `78bd6de`, post fix-package-6) and fixed. Nothing was
skipped; nothing needed a database migration this round.

## 🟡 Real bugs

**1. `/reseller/transfers` Label/Country columns always empty** —
`allocate/route.ts` never sets `credential_id` on a transfer (confirmed via
grep — it isn't set anywhere), so the `proxy_credentials(*)` join always
came back null. Dropped the join and the two dead columns from
`app/reseller/transfers/page.tsx` rather than trying to populate
`credential_id`, since allocations genuinely aren't 1:1 with a credential in
the current data model — that would be a bigger design change than this
audit called for.

**2. Admin nav never got the API Keys link** — confirmed in
`components/dashboard/DashSidebar.tsx`: the unconditional
`if (role === 'admin') nav = adminNav` discarded any injection before it,
and `adminNav` itself had no entry for it. Now injects `apiKeyItem` between
Credentials and Settings for admins, mirroring how it's already injected for
resellers with `api_access`.

**3. `npm run deploy` was a footgun** — same manual `wrangler deploy` path
already known (from GlobProxy's own history) to silently strip secrets vs.
deploying via GitHub Actions, sitting under the generic name `deploy` where
muscle memory could trigger it by accident. Renamed to
`deploy:manual-DANGER` in `package.json`. `build:cf` + GitHub Actions remain
the only sanctioned path — nothing else changed about how deploys actually
work.

## ⚪ Minor / cosmetic

**4.** Removed dead `sendAccountDeletionEmail()` from `lib/email.ts` —
confirmed zero call sites anywhere; both delete routes already build their
own inline email.

**5.** Removed unused `lucide-react` dependency from `package.json` —
confirmed zero imports anywhere in `app/`, `components/`, `lib/`.
**`package-lock.json` regenerated and included in this archive** — needed
so the lockfile stays in sync with `package.json` after the removal
(`npm ci` would otherwise complain about drift).

**6. Homepage CTA pricing corrected — flagging this one explicitly, since
it's a judgment call, not a pure bug.** Both hero and bottom CTAs said
"Start from $35" while `lib/plans.ts`'s actual cheapest plan (Micro) is
$4.50 — directly contradicted by the pricing table rendered on the same
page. The audit flagged this as possibly intentional (not wanting to lead
with the pay-as-you-go tier). I fixed it to "$4.50" on the reasoning that
advertising a floor price 7-8x higher than your actual cheapest plan, on
the same page as a table showing otherwise, reads as a bug rather than
positioning. **If you actually want to lead with $35 as a deliberate
choice** (e.g. Starter is the plan you want most people to land on), revert
just this one and let me know — it's a one-line change in `app/page.tsx`
(two places), not tied to anything else in this package.

**7.** Added a forward-pointer comment in
`supabase/migrations/0007_reserve_credential_bandwidth.sql` noting its
balance-check formula is superseded by `0009` — no functional change,
`0009` still runs after it and `CREATE OR REPLACE`s the function, this is
purely so the migration history doesn't mislead a future reader.

**8.** Corrected the misleading `(admin only)` comment on the cron `GET`
handler in `app/api/cron/[task]/route.ts` — it's gated on `CRON_SECRET` via
`validateCron()`, not an admin session. No behavior change, just an
accurate comment so nobody assumes browser-session auth is sufficient here.

## No database migration needed

Everything here is application code + one dependency removal.
