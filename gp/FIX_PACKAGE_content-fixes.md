# Content fixes: rotating-vs-sticky accuracy and meta descriptions

Built on `6b63c40`. Only `lib/blog/posts.ts` (plus one new test). No migration, no env change. Text only.

## Accuracy: `rotating-vs-sticky-sessions`
- It said rotating sessions change IP "on a set interval you configure" and had "(or on a timer)" in a heading. That does not exist: rotating gives a new IP per connection; holding one IP for a chosen time is the sticky mode. Heading and paragraph corrected, pointing readers to sticky for time-based holding.
- FAQ "How long can a sticky session last?" now states the real range (1 minute to 24 hours / 1440 minutes, default 10 minutes).
- The "On GlobProxy" callout now says how to switch (Edit tab → IP behaviour; port changes; bandwidth unaffected), matching the sticky help article.

## Meta descriptions over 160 characters (11 posts, wording trimmed, meaning unchanged)
The three flagged earlier (city-level-proxy-targeting-explained 191, ad-verification-geo-targeted-proxies 172, non-expiring-proxy-bandwidth 169) plus eight more found by auditing all 22 posts: local-seo-rank-tracking-proxies, social-media-management-proxies, iproyal-alternative-non-expiring-bandwidth, proxy-pool-size-explained, reseller-api-automating-sub-user-provisioning, reseller-auto-topup-client-bandwidth, ip-whitelisting-client-proxy-credentials, pricing-your-white-label-proxy-service. All 22 are now 160 or less.

## Checks
tsc clean, supplier-leak OK, 195 tests pass (2 new in tests/blog-meta.test.mjs: every description ≤160, and the rotating timer claim cannot return). All 22 articles render.

## Not touched (still open, need your call)
- ip-whitelisting post's body claims about whitelist behaviour are unverified against the code.
- Titles: several older posts have titles longer than ~60 chars, which search engines truncate; left alone.
