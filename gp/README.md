# GlobProxy — Wave 2: reseller-facing content

Verified against a fresh pull of `main` (via codeload tarball — `git clone` hit an
auth quirk against the proxy in my sandbox this session; codeload worked fine
and is a plain read-only tarball of the same commit, so this is genuinely
built on top of everything merged so far, including the IndexNow CI step).

Ran the same three checks as every previous package: `npx tsc --noEmit`
(clean), `npx opennextjs-cloudflare build` (clean — `OpenNext build complete`,
now shows 15 blog posts total including these 5), and `npx wrangler deploy
--dry-run` (clean, 47 sitemap URLs — the 42 from before plus these 5 posts).

## What this ships

**3 files changed, all edits — no new files, no new routes:**

- `lib/blog/types.ts` — added `'Reseller'` to the `BlogCategory` union.
- `lib/blog/posts.ts` — appended 5 reseller-facing articles:
  1. **How White-Label Residential Proxy Reselling Actually Works** — the
     business-model explainer (stock, allocation, your own pricing).
  2. **Automating Sub-User Provisioning With the Reseller API** — walks the
     real `POST /api/v1/sub-users` → usage → topup → delete loop.
  3. **Setting Up Auto-Topup So Client Bandwidth Never Silently Runs Out** —
     covers the real `PATCH .../auto-topup` endpoint, including when *not*
     to use it (fixed prepaid allocations).
  4. **IP Whitelisting for Client Proxy Credentials** — the three real
     whitelist endpoints (GET/POST/DELETE), plus the known 409-during-
     provisioning quirk already documented in your API docs page.
  5. **Pricing Your White-Label Proxy Service** — a framework, not a fixed
     number — deliberately doesn't invent a "recommended markup" since
     GlobProxy doesn't set one.
- `app/docs/api/page.tsx` — added one small "Guides" link row right under the
  intro paragraph, linking to all 5 new posts. This is the one piece of
  internal-linking work here: reseller-minded visitors are already on this
  page reading the API reference, so this is the highest-intent place to
  surface the new content, not just the `/blog` index.

## Accuracy check I did before writing any of this

Read `app/reseller/layout.tsx`, `app/reseller/earnings/page.tsx`, and the
existing `app/docs/api/page.tsx` (416 lines, already comprehensive) before
writing a word, specifically to confirm:
- The real model is stock-purchase-and-allocate via `reseller_transfers`
  (pending/active status), **not** a revenue-share or commission structure —
  so none of the posts invent a "you earn X%" claim. They're explicit that
  GlobProxy doesn't set or take a cut of reseller pricing.
- Every endpoint referenced (`sub-users`, `usage`, `topup`, `auto-topup`,
  `whitelist`) and every pricing figure ($4.50 Micro, $2.00/GB at 500 GB
  Scale) is pulled from the actual `lib/plans.ts` and `app/docs/api/page.tsx`
  in the repo, not assumed.

## Apply

```bash
cd C:\Users\jackk\Desktop\MyWebApps\globproxy\gp
tar -xzf ~/Downloads/globproxy-wave2-reseller-content.tar.gz -C .
git add lib/blog/types.ts lib/blog/posts.ts app/docs/api/page.tsx
git commit -m "content: 5 reseller-facing articles (white-label model, API automation, auto-topup, whitelisting, pricing) + API docs cross-links"
git push origin main
```

Runs from `gp/` as usual — nothing in this package touches `.github/` or the
repo root.

## What I deliberately did not build in this pass

Per your last "unfinished business" rundown, wave 2 had three parts. This
package is just the first:

- **Reseller content** — done, this package.
- **More `/vs/[competitor]` comparison pages** beyond the two existing blog
  posts (IPRoyal, DataImpulse) — held off, same reasoning as before: wait to
  see if the two live ones get any traction before building more.
- **Expanding the 28 location pages** based on real impression data — still
  gated on GSC/Bing actually having data, which you said you'd check back on
  in a few days. Nothing to build here yet without guessing blind.

Say the word on either of those once there's real data to point at, or if
you'd rather build them now on judgment instead of waiting.
