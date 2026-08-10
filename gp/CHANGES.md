# Invoice / billing-history export — rebuilt on top of your recent pushes

Closes: "No invoice/billing-history export on the Billing page."

**This is a rebuild.** You pushed three commits after my last handoff
(webhook endpoints + default auto-topup, and mandatory 2FA for
admin/reseller) before I could apply the previous package. I re-cloned,
checked for overlap, and reworked three things so nothing gets clobbered
and the new feature actually respects what you just shipped:

## What overlapped, and what I changed because of it

1. **Migration numbering collision.** Your two pushes claimed
   `0018_webhook_endpoints.sql`, `0019_default_auto_topup.sql`, and
   `0020_mfa.sql`. My invoice-numbers migration was originally `0018` too
   — renumbered to **`0021_invoice_numbers.sql`**. Confirmed none of the
   three touch the `orders` table or `claim_and_credit_order()`, so no
   logic conflict, just the filename.

2. **A CSV export utility already exists.** Your "usage time-series,
   host/country drill-down" commit added `lib/csv.ts` (`toCsv` +
   `csvResponse`) and wired it into `/api/dashboard/usage/history` as a
   plain `<a href="...&format=csv">` link (cookie-session auth, no
   client-side fetch/Blob needed). I'd independently built a
   parallel bespoke client-side CSV generator for this — **dropped it**
   and rebuilt billing export as `app/api/dashboard/billing/export/route.ts`
   using your existing `toCsv`/`csvResponse`, linked from the Billing page
   the same way your usage page links to its CSV export. One CSV
   mechanism in the codebase, not two.

3. **Mandatory MFA gate has a hole my original design would have left
   open.** Your 2FA commit gates every path under `/dashboard`,
   `/reseller`, `/admin` for admin/reseller roles
   (`middleware.ts`'s `isProtected` + `mfaRequired` block). My invoice
   page lives at the top-level `/invoice/[id]` (deliberately, so the
   printed output has no dashboard chrome to hide) — outside that list.
   Left as originally built, an admin or reseller account could reach the
   same billing/PII data at `/invoice/{id}` without ever completing MFA
   step-up, defeating the point of "mandatory for every protected
   surface." Fixed with a **4-line, single-purpose addition to
   `middleware.ts`**: `/invoice` added to the `isProtected` path list,
   with an inline comment explaining why. Nothing else in that file
   touched — the diff is exactly that one line plus its comment, and the
   matching update to the file-level matcher comment so the docs stay
   accurate.

Everything else (the invoice document itself, the atomic invoice-number
assignment inside `claim_and_credit_order()`, the Billing page's
"Invoice" link per paid/refunded row) is unchanged from before.

## Files in this package
- `supabase/migrations/0021_invoice_numbers.sql` (renumbered from 0018)
- `supabase/schema.sql` — same end-state, applied against your current
  file (confirmed the `orders` table / `claim_and_credit_order` section
  was untouched by your three commits, so this is a clean reapply)
- `middleware.ts` — one line + comment, adds `/invoice` to `isProtected`
- `app/api/dashboard/billing/export/route.ts` — new, uses your `lib/csv.ts`
- `app/dashboard/billing/page.tsx` — "Export CSV ↓" now a plain link to
  the route above (not a client-generated Blob); "Invoice" link per
  paid/refunded row, unchanged from before
- `components/InvoiceActions.tsx` — unchanged from before
- `app/invoice/[id]/page.tsx` — unchanged from before, comment updated to
  point at migration 0021 and note middleware's gate

## Verified
- `npx tsc --noEmit` — clean.
- `npx next build` — succeeds against your current tree; every route from
  your three recent commits (`/api/auth/mfa/*`, `/api/dashboard/webhooks/*`,
  `/api/dashboard/settings/auto-topup-default`, `/auth/mfa-setup`,
  `/auth/mfa-verify`, etc.) plus this feature's two new routes
  (`/api/dashboard/billing/export`, `/invoice/[id]`) all show up correctly
  in the route table together.
- Confirmed no other file this feature touches was modified by your three
  commits, so there was nothing else to reconcile.
- No unrelated files touched (`package-lock.json` diff from `npm install`
  reverted before packaging).

## Still true from before (unchanged reasoning)
- PDF via the browser's print dialog, not a server library — this app
  deploys to Cloudflare Workers, where a Node PDF library is a real
  compatibility risk even with `nodejs_compat`.
- Invoices only exist for `paid`/`refunded` orders; a later refund
  doesn't erase the original invoice.
- CSV includes every order regardless of status — "billing history" is
  the full record, not just successful charges.
- No tax/VAT line — nothing in `orders`/`plans` carries tax data, and
  Paystack is charged flat USD.
