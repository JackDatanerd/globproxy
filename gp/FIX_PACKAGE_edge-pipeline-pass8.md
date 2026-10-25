# Edge & request pipeline — pass 8

Independent audit of: middleware.ts, custom-worker.ts, next.config.ts, open-next.config.ts,
wrangler.jsonc, lib/rateLimit.ts, lib/ssrfGuard.ts, lib/supabase/*.

## Fixed
- **B1/F5 request ids at the edge.** Every /api answer now carries X-Request-Id, including the
  Worker's own 400/403/413/429 answers (docs promise it on every response). A route's own id
  (v1 routes) is kept; a safe caller-supplied id is honoured. lib/edgeGuard.ts `edgeRequestId`.
- **B2 headers on middleware-made responses.** OpenNext returns a middleware response before it
  merges next.config headers, so login/2FA redirects and the 503 page had no HSTS / nosniff /
  X-Frame-Options. One list (lib/securityHeaders.ts) now feeds next.config.ts, middleware.ts and
  the Worker's own answers.
- **B3 refresh brake no longer locks people out.** Over budget, page and /api/auth/* requests drop
  their stale sb-* cookies and continue as anonymous (protected pages redirect to sign-in); other
  /api calls still get the 429. Shared carrier addresses can no longer lock expired-cookie users
  out of the login page and the login endpoint.
- **F2 dead-man's switch.** Optional HEARTBEAT_URL secret: the Worker GETs it after a fully OK
  */5 chain (silent when any task fails). `/api/health?deep=1` + x-cron-secret also reports stale
  scheduled tasks (503), read-only; the deploy smoke test does not send ?deep so it cannot roll back.
- **F4 CSP_MODE_PROTECTED.** Promote the signed-in nonce policy to enforcing on its own
  (GitHub variable CSP_MODE_PROTECTED=enforce); unset it follows CSP_MODE as before.
- **F1 supplier name, code side.** lib/geonode.ts -> lib/upstream.ts, GeonodeApiError ->
  UpstreamApiError, /api/admin/debug-geonode -> /debug-upstream, comments and messages neutralised
  (93 -> 6 mentions in that file; credentials.ts -> 0). UPSTREAM_API_KEY / UPSTREAM_RESELLER_ID
  are read first, the legacy names still work. Baseline shrunk.
- F3 (admin MFA required) was already shipped by another session; not touched.

## Operator steps (not code)
1. Make the GitHub repo PRIVATE now. History still names the supplier; scrub with git filter-repo
   if you ever need it public. SQL migrations (excluded from the ratchet) also name it.
2. Optional secret rename: set UPSTREAM_API_KEY and UPSTREAM_RESELLER_ID as Worker + GitHub
   secrets, then change the two names in deploy.yml's `secrets:` list/env block, then delete the
   old secrets. Remaining literal: the three supplier API host URLs in lib/upstream.ts (move to an
   env var in a later round once the secrets above exist).
3. Create a free Healthchecks.io (or similar) check, period 5 min grace 10 min, set its URL as
   the HEARTBEAT_URL GitHub secret. Point an uptime monitor at /api/health?deep=1 with header
   x-cron-secret.
4. Anyone running with the old route path must use /api/admin/debug-upstream.
