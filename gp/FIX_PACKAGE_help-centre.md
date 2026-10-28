# Help centre: /help, separate from /blog

Built on `e168ca2`. No migration, no env change. Pure content/routing; no behaviour outside the public site.

## What changed
- **New section `/help`**: hub page (`app/help/page.tsx`, grouped by topic from `lib/blog/help.ts`) and article pages (`app/help/[slug]`, with Open Graph image).
- The 7 support articles are marked `section: 'help'` in `lib/blog/posts.ts`. They no longer appear on `/blog`, its static params, related reading or sitemap-as-blog.
- **Old links keep working**: `next.config.ts` `redirects()` is generated from the same data, so each `/blog/<help-slug>` sends a permanent redirect to `/help/<slug>`. Verified in the build's routes manifest. Next emits **308** (method-preserving 301; treated the same by search engines).
- A new help article now needs only `section: 'help'` in posts.ts plus one line in `HELP_TOPICS`; a test fails if either is missed.
- Shared layout `components/blog/PostArticle.tsx` (blog and help render the same). Help pages use a "Still stuck? Contact support" box instead of the "Try 1 GB" sales box, breadcrumb "Help", canonical `/help/<slug>`.
- Navbar gets "Help"; homepage footer gets "Help centre"; sitemap lists `/help` and the articles at their new URLs; the Worker's anonymous edge cache covers `/help` and `/help/<slug>`.

## Checks
tsc clean, `next build --webpack` OK (7 help pages prerendered, blog index no longer lists them, canonical correct), supplier-leak ratchet OK, 174 tests pass (6 new in tests/help-section.test.mjs).

## Notes
- Search engines will take a little while to swap /blog URLs for /help; the redirects carry the ranking.
- When you want the "Report an issue" button (next task) to link here first, the hub's "Contact support" mailto is already support@globproxy.com.
