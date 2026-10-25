# Fix package — Edge & request pipeline

Scope: middleware.ts, custom-worker.ts, next.config.ts, open-next.config.ts, wrangler.jsonc,
lib/rateLimit.ts, lib/ssrfGuard.ts, lib/supabase/*, plus the routes they protect.

## Built / fixed
- middleware: 4s upstream timeout; auth/profile/MFA outage => 503 (never a bounce to login, never waved through);
  missing profile row fails closed; refreshed Supabase cookies survive 503s and redirects.
- rate limits: per-IPv6-/64 keys; no shared "unknown" bucket; new per-target (email), per-user, and pre-auth
  per-IP v1 API limiters (wrangler namespace ids 1101-1104); consistent Retry-After / X-RateLimit-Limit.
- SSRF: webhook URLs reject GlobProxy's own hosts and non-443/8443 ports before DNS.
- custom-worker: anonymous edge cache for public pages (GET, no cookie/query/RSC, 200 html only, 300s);
  cron base URL normalised (trailing slash used to stop the whole chain); errors swallowed inside 200s are logged.
- next.config: CSP (Report-Only) + /api/csp-report, COOP, noindex on workers.dev, no X-Powered-By.
- open-next.config: built with defineCloudflareConfig.
- deploy.yml: NEXT_PUBLIC_TURNSTILE_SITE_KEY at build; optional Worker secrets step (Turnstile, MFA keys).
- cron route: dead duplicate `reconcile` case removed. .gitignore: supplier-*.json.

## Ops steps
1. GitHub secrets: NEXT_PUBLIC_TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY, MFA_ENCRYPTION_KEY (openssl rand -base64 32).
2. Make the repo private; supplier dump files must be untracked (commands in the delivery message).
3. Preview-deploy, watch CSP reports, then promote CSP to enforcing.
