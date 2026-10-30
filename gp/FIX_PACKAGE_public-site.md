# Public site & SEO (section 11): independent pass, 13 findings plus 3 found while verifying

Built on `21a48c5`. No migration, no env change. One new dependency-free module set, four self-hosted font files.

## Fixed
1. **Social cards / canonicals** — new `lib/seo.ts` `pageMetadata()` builds title, description, canonical, Open Graph and Twitter together. Used by /terms, /privacy, /refunds, /status, /locations, /locations/[country], /blog, /help, both article routes and /docs/api. The homepage gets its own canonical. The root layout's Twitter card now has a real title/description. Before: those pages inherited the homepage's og:title/og:url and `/blog`, `/help` lost og:image.
2. **Mobile navigation** — `Navbar` has a hamburger menu below 1024px (7 links + both buttons overflowed at 768px), skip-to-content link, Escape/route-change close, `aria-expanded`. New shared `components/Footer.tsx` on every public page (homepage, blog, help, status, locations, legal, docs, unsubscribe); each page has `<main id="main">`.
3. **Comparison claims** — "Competitors expire monthly / Required ✗ / Extra cost" are now "Many providers…" / "Often monthly / required / extra", consistent with the IPRoyal article. Refund guarantee line added under the pricing cards. (The 45%, $/GB figures, uptime, user count and hero card were left for you.)
4. **Supplier guard on public text** — `/api/admin/record-benchmark` rejects a label/notes naming the supplier; `/status` also drops such rows/notes at render time.
5. **Locations data** — Brazil lists Brasília, not Brasiléia (generator `norm()` now folds accents). Singapore is 1 city, not 5 (`CITY_COUNT_OVERRIDE`). "1 city" pluralisation.
6. **Fonts** — self-hosted via `next/font/local` (`app/fonts.ts`), Google `@import` removed, CSP no longer allows fonts.googleapis/gstatic. Size-adjusted fallbacks stop the headline reflow. Verified loaded in Chromium, no console errors.
7. **Contrast (AA)** — new Tailwind tokens `subtle` (5.05:1) and `accent2-dark` (5.34:1) replace `muted`/`accent2` for small text on light backgrounds across the public pages; footer and CTA copy raised from white/25–40 to white/50–60. Dashboard/admin untouched.
8. **/status** — shows how long ago and the UTC time of each measurement, a "results are out of date" banner after 24 h, and a "How we measure" note (plain HTTP, 5 requests per run).
9. **`/r/` clicks** — `robots.ts` disallows `/r/`; known crawlers/unfurlers (`lib/botUa.ts`) still get the redirect but are not counted.
10. **Navbar auth flash** — session read locally (`getSession` + `onAuthStateChange`) instead of a Supabase Auth round-trip per page; the button slot is reserved until known.
11. **Legal** — Privacy "Last updated" corrected, Turnstile disclosed under Cloudflare, Google Fonts no longer used; Terms gain "Changes to These Terms" (governing law stays commented out, with a TODO for counsel); all three have descriptions.
12. **Hard-coded prices** — location meta description and article CTA read the entry price from `lib/plans.ts`.
13. **Sitemap / titles** — sitemap adds /status and the legal pages and real `lastModified` for /blog and /help; all 28 posts get a ≤60-character `<title>` from `lib/blog/seoTitles.ts` (the full headline stays on the page, OG and JSON-LD).

## Found while verifying (not in the audit)
- `/docs/api` scrolled sideways on phones (error-code tables had no scroll container; long endpoint paths could not wrap).
- Long unbroken strings in article text (e.g. a `socks5h://…` line in a help article) widened the page; article blocks now wrap.
- The new `/unsubscribe` page rendered the Navbar with no `#main` target; it now has the shared shell.

## Checks
tsc clean; 330 tests pass (13 new in `tests/public-seo.test.mjs`); supplier-leak ratchet, api-docs, cron and schema checks OK; `next build --webpack` OK; rendered `<head>` verified for every route group; all 66 sitemap URLs plus /unsubscribe checked in Chromium at 320/375/768/1024/1440 px — one h1, one `main#main`, one footer, no horizontal scroll.

## Left for you
Homepage stats and claims (35M+, 99.9% uptime, 1,400+, "up to 45%", $/GB table), the static "LIVE" hero card, and the terms governing-law clause.
