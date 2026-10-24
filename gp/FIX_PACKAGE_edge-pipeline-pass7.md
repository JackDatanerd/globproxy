# Edge & request pipeline — pass 7

Independent audit of middleware.ts, custom-worker.ts, next.config.ts, open-next.config.ts,
wrangler.jsonc, lib/rateLimit.ts, lib/ssrfGuard.ts, lib/supabase/* (plus edgeGuard, csp,
authOutage, authThrottle, the deploy workflow and the routes that call the limiters).
Audited at de1df5c, fixed on 4628299. Full suite: 21 new tests, `tsc`, every `check:*` script and a
real `next build --webpack` all green.

## Before you deploy (one-time checks — not code)
1. **Paystack dashboard → Settings → API & Webhooks**: the webhook URL must be
   `https://globproxy.com/api/webhooks/paystack` (the custom domain, NOT a `*.workers.dev` address).
   If it points at workers.dev, payments are credited late (the 5-minute reconcile cron still
   catches them) until you change it — but fix it first.
2. **Supabase → Auth → URL configuration**: Site URL and every Redirect URL on the custom domain.
3. **Cloudflare → Workers → this Worker → Settings → Domains & Routes**: `globproxy.com` (and
   `www`) listed as Custom Domains. `workers_dev` / `preview_urls` are now off, so the custom
   domain is the only way in. The deploy smoke test now rolls back if the domain stops answering
   at all.
4. Optional: Supabase → Auth → Rate Limits — note the token-refresh limit (see "Added" below).

## Fixed
- **Anyone could block a victim's password reset** (`lib/rateLimit.ts`, signup / reset /
  resend-confirmation routes). The per-target cap (6 per 10 min on the e-mail alone, global,
  in Postgres) let anyone who knew an address spend the whole budget and answer the owner's own
  request with a 429 — and password reset is the documented way out of the sign-in throttle. An
  e-mail triggered by someone else is useless to the owner (PKCE verifier cookie), so the owner's
  request has to be able to go through. Now two exact buckets (`lib/targetThrottle.ts`): per
  (e-mail, calling address) 4 / 10 min, checked first and returning early, plus an all-callers
  ceiling of 40 / hour. One address can contribute at most 24 / hour to the ceiling, so it takes
  several addresses to push the owner into it; an inbox is still bounded to 40 mails an hour. The
  Cloudflare-binding layer now includes the address in its key too.
- **`workers_dev` and per-version preview URLs were on** (`wrangler.jsonc`). Both sit outside the
  zone (no WAF / bot / rate rules) and every uploaded version — including old ones kept for
  rollback — got its own public URL. Both off.
- **`global_fetch_strictly_public` added**: every `fetch()` (customer webhook URLs, provider and
  payment APIs) goes over the public internet; a hostname on one of this account's own zones is
  no longer routed to that zone's Worker/origin.
- **Protected-path matching** (`middleware.ts`, `next.config.ts`): plain `startsWith` treated
  `/administrator`, `/dashboards`, `/reseller-program` as signed-in pages. Now whole path
  segments, one list in `lib/protectedPaths.ts` read by both files, so they cannot drift. Checked
  against the generated routes-manifest on a real build.
- Stale comments/log line in `lib/rateLimit.ts` still sent operators to `unsafe.bindings`.
- Deploy smoke test: a domain that answers nothing at all (000 on all three probes) is now treated
  as broken and rolled back; before, only 5xx counted.

## Added
- **Session-refresh brake** (`custom-worker.ts`, `lib/sessionProbe.ts`, new binding
  `SESSION_REFRESH_RATE_LIMITER`, 20 / min per address). Every page request with a session cookie
  makes the server call Supabase Auth to refresh an expired token; Supabase rate-limits refreshes
  per source address (default 150 / 5 min), and the Worker's address is shared by everyone served
  from that location. A trickle of requests with made-up "expired" cookies could use that budget
  up and turn real users' refreshes into 503s on every signed-in page. The Worker now reads the
  cookie (no network) and applies the brake only to requests that WOULD refresh — a browser does
  that about once an hour. Fails open; unreadable cookies are not counted (no network call).
- **Edge cache**: (1) visitors who carry only `gp_ref` / `gp_sub` (set for 60 days by referral
  landings) or Cloudflare's own cookies now share the cached copy — before, every referred visitor
  bypassed the cache on every public page; allow-list, so any other cookie still bypasses it.
  (2) stale-while-revalidate: a copy past its 5-minute TTL is served immediately (`x-edge-cache:
  STALE`) and refreshed once per location in the background, for up to 10 more minutes. `/status`
  is exempt — live health is never served older than the TTL.
- `lib/ipParse.ts`: address parsing/grouping moved out of `lib/ssrfGuard.ts` so the rate limiter
  and the Worker no longer depend on the webhook guard for it (ssrfGuard behaviour unchanged).

## Tests
`tests/edge-pipeline.test.mjs` (pure rules) and `tests/worker-edge.test.mjs`, which bundles the
REAL `custom-worker.ts` with esbuild against a stub app and an in-memory Cache and exercises HIT /
MISS / STALE, the single background refresh under concurrency, the brake, and the API guard. Five
deliberate mutations (no dedupe, referral cookies not benign, brake always allows, per-address cap
raised, /status given SWR) each fail a test.

## Verified and ruled out
Nonce CSP (48-char nonce, no padding), body/origin guard, cron ↔ wrangler ↔ limiter sync, unique
namespace ids, fail-closed profile/MFA lookups, page-gate vs API-gate MFA agreement, SSRF literal
and DNS handling, supplier name absent from every customer-visible string in this section.

## Left as is, on purpose
- A cookie that LOOKS fresh but carries a made-up access token costs one `/user` call per request;
  it cannot be told from a valid one without the project's JWT key, and that call is not subject
  to the refresh budget the brake protects.
- `limitBody` rebuilds the request (drops `request.cf` and the `Content-Length` header); nothing
  in the repo reads either.
- The distributed-flood ceiling (40 mails / hour to one inbox) is a deliberate trade-off: a lower
  global cap is exactly the lock this pass removes.
- DNS-rebinding window in ssrfGuard (documented in the file) — narrowed per delivery, not closed.
