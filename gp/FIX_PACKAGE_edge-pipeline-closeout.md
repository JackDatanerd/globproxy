# Fix package — Edge & request pipeline close-out (audit pass 2)

Scope: middleware.ts, custom-worker.ts, next.config.ts, open-next.config.ts, wrangler.jsonc,
lib/rateLimit.ts, lib/ssrfGuard.ts, lib/supabase/*, plus the routes and workflow they touch.
Built on origin/main aaa733a. Migration: **0055_edge_pipeline_closeout.sql** (schema.sql folded in).

## Feature gaps closed
- **G1 health + smoke test + rollback** — `GET /api/health` (db reachable, required settings present,
  deployed version id; 200/503). `deploy.yml` calls it after deploy and runs `wrangler rollback` if the
  new version answers 5xx. A non-5xx failure (challenge page, 403/429, network) only warns, so a
  bot-protection rule can never roll back a good deploy. Missing-setting names are only shown to callers
  holding the cron secret, and under neutral labels (public repo => public CI logs).
- **G2 cron heartbeat** — every `/api/cron/[task]` run is recorded (`cron_task_runs`). Three consecutive
  failed runs, or a task that stops running, emails the admin once per incident. Hourly `stock` task does
  the staleness check. Admin → Settings → "Scheduled tasks" shows last run / last success / errors.
- **G3 request guard in the Worker** (`lib/edgeGuard.ts`) — /api/* bodies over 1 MiB are refused (413 by
  Content-Length; chunked bodies are cut off by a counting stream). State-changing /api/* calls from a
  foreign Origin / `Sec-Fetch-Site: cross-site` get 403, for every route including future ones. Exempt
  (not cookie-authenticated): /api/webhooks/*, /api/cron/*, /api/v1/*, /api/csp-report.
- **G4 CSP reports are reviewable** — `/api/csp-report` aggregates into `csp_violations` (capped at 500
  rows, 30-day prune); Admin → Settings lists them most-hit first. Still Report-Only: promote by renaming
  the header in next.config.ts once the list is quiet. `Permissions-Policy` now delegates `payment` to
  checkout.paystack.com.

## Bugs fixed
- **B1** edge cache key now includes the deployed version (`version_metadata` binding) — a deploy can no
  longer be followed by cached HTML pointing at deleted JS chunks.
- **B2** "per-user" limits were per address+user (bypassable by changing address). Added true per-account
  limits (`rateLimitedUser`) to reseller allocate/reclaim, checkout, proxy create/retry/top-up/delete,
  usage history, payout-method, reseller/affiliate apply.
- **B3** whitelist (single, bulk, list), proxy delete and webhook update now throttled per user; upstream
  provider 429s get one short retry (shared reseller key).
- **B4** `keep_vars: true` in wrangler.jsonc; INVOICE_SELLER_*, SUPABASE_CAPTCHA_ENABLED, REFERRAL_IP_SALT,
  PASSWORD_BREACH_CHECK are now pushed as Worker secrets by deploy.yml when set in GitHub.
- **B5** csp-report reads its body with a real cap (was read-then-truncate).
- **B6** per-email limiter canonicalises `+tag` and Gmail dots/googlemail.
- **B7** middleware matcher no longer skips protected prefixes for URLs ending in a file extension;
  `/invoice` got a layout (suspended/deleted/MFA) and a uuid check.
- **B8** `GET` api-keys, webhook deliveries and my-ip now check suspension.
- **B9** webhook hostnames that CNAME to our own domain / workers.dev are refused.
- **B10** stale comments corrected (rateLimit.ts, wrangler.jsonc, cron route).

## Ops steps
1. Run `supabase/migrations/0055_edge_pipeline_closeout.sql` in Supabase. (Deploying first is safe: the
   heartbeat and CSP aggregation log and carry on until the tables exist.)
2. GitHub secrets (only the ones you actually use): INVOICE_SELLER_NAME, INVOICE_SELLER_ADDRESS,
   INVOICE_SELLER_TAX_ID, SUPABASE_CAPTCHA_ENABLED (only together with the Supabase CAPTCHA toggle),
   REFERRAL_IP_SALT, PASSWORD_BREACH_CHECK.
3. Make the GitHub repo private (it is publicly readable and names the supplier throughout). Untrack the
   supplier dump files: `git rm --cached ../geonode-*.json` (history keeps them until the repo is private).
4. After the first deploy: open /api/health, and Admin → Settings to see the new panels.

## Verified
tsc clean; `next build --webpack` and `opennextjs-cloudflare build` succeed; `wrangler deploy --dry-run`
accepts the bundle and binds `CF_VERSION_METADATA`; schema-sync check passes; 55 logic checks pass
(guard, body limits, email canonicalisation, CNAME check, matcher incl. Next's own parser).
Not verifiable from here: behaviour on live Cloudflare (cache purge on deploy, rollback command, Paystack
Apple/Google Pay under the new Permissions-Policy).
