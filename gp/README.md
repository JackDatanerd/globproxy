# GlobProxy UI overhaul — Overview, My Proxies, New Session

Implements the three mockups (`globproxy-ui-refinements.html`) directly in the real app,
against a fresh clone at commit `12471f4`. Verified with `npx tsc --noEmit` and a full
`npx next build` — both clean, zero errors.

## Files in this archive

```
app/dashboard/page.tsx                      (replaced)
app/dashboard/proxies/page.tsx               (replaced)
app/dashboard/proxies/new/NewProxyForm.tsx   (replaced)
components/dashboard/ProxyCard.tsx           (replaced — same filename, now a
                                               collapsible row instead of an
                                               always-open card; takes new
                                               `expanded`/`onToggle` props)
components/dashboard/ProxyList.tsx           (new — search/filter toolbar +
                                               single-expanded-row state,
                                               wraps ProxyCard)
```

Nothing else changed — `SessionManager.tsx`, `lib/proxyEndpoint.ts`, `lib/geoTargeting.ts`,
and every API route are untouched. All real geo-targeting selects (country/state/city
sourced from Geonode's actual supported locations, not free text) were preserved exactly
as they were — my earlier static mockup used plain text inputs for state/city as a
simplification for the demo, but that's not what got wired in here.

## Apply

```bash
git checkout -b ui-overhaul
```

Drop these 5 files into place at the paths shown above (or extract this archive at your
repo root — the paths match), then:

```bash
git add app/dashboard/page.tsx app/dashboard/proxies/page.tsx \
        app/dashboard/proxies/new/NewProxyForm.tsx \
        components/dashboard/ProxyCard.tsx components/dashboard/ProxyList.tsx
git commit -m "ui: row-based proxy list, split new-session form, condensed overview"
git push
```

## What changed, and why

**`/dashboard/proxies`** — Every session used to render as a fully-open card. Now each
is a single-line row (colored left rail = status, no badge-reading needed) that expands
on click; credentials/endpoints/code are tabs instead of stacked. Added a search box and
Active/Pending status filter — didn't exist before. Only one row expands at a time.
A quick-copy icon on the collapsed row covers the most common action (grab the first
endpoint) without expanding — **rotating credentials only**; sticky credentials don't get
one since there's no single "the" endpoint until a session is created under
Sticky Sessions, and copying the bare targeting prefix would be a non-working string
someone might paste in expecting it to connect.

**`/dashboard/proxies/new`** — Was 5 stacked bordered boxes + a preview box after all of
them. Now one continuous card with numbered sections, ASN moved behind an "Advanced
targeting" disclosure, and a sticky "receipt" panel on the right showing the live
endpoint preview, running GB math, and the submit button — visible the whole time you're
configuring, not just after scrolling to the bottom.

One deliberate behavior change worth knowing about: the GB input no longer has a
browser-level `max` attribute clamping it to your available balance. Instead the receipt
panel shows *why* it's blocked (red bar + "exceeds your available balance") and disables
submit. Functionally equivalent, but it's live JS state instead of a static HTML
attribute — mentioning it since it's slightly more surface area than before.

**`/dashboard`** — Four equal-weight stat tiles + a separate full-width bandwidth bar
(which mostly duplicated the one on `/proxies`) became one dark "balance" hero card
carrying the number, the bar, and the buy CTA together, since that's the actual job of
this page. The other two stats (active proxies, total purchased) step down to quiet
supporting tiles. The sessions list now uses the same colored-rail status language as
`/proxies` instead of a dot + text, so status reads the same way on both pages. Orders
got real paid/pending/failed pills instead of one badge doing double duty as color and
label.

## Known gaps / not touched this round

- `/dashboard/billing`, `/dashboard/usage`, `/dashboard/settings`, `/dashboard/api-keys`,
  the admin pages, and the marketing site were **not** touched — no mockup was built for
  them yet, so I didn't want to freehand a redesign without you seeing it first. Say the
  word if you want those next.
- This only covers the UI refinement work from this conversation. It does **not** include
  fixes for anything from the earlier code-review pass (suspended-user API gap, the
  `signOut(user_id, ...)` bug, the bandwidth reclaim-via-delete exploit) — those are
  separate and still open, see `globproxy-audit-findings.md` from earlier in this thread.
