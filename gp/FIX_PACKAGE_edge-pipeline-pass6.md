# Edge & request pipeline — pass 6

Independent audit of middleware.ts, custom-worker.ts, next.config.ts, open-next.config.ts,
wrangler.jsonc, lib/rateLimit.ts, lib/ssrfGuard.ts, lib/supabase/*.

## Fixed
- **middleware.ts** — forced sign-out of a suspended/deleted account ignored `signOut()`'s
  returned error. supabase-js (locked 2.104.0) only removes the session cookies when the logout
  call succeeds or answers 401/403/404; on a 5xx or network failure it returns `{ error }` and
  leaves the session in place. The redirect to /auth/login then carried a live session. Now every
  `sb-*` cookie is expired on that redirect regardless of the logout result, the failure is logged,
  and 2FA proofs are still revoked.
- **lib/rateLimit.ts** — `rateLimitedTarget` ran the Cloudflare binding and the exact Postgres cap
  in one `try`; a binding error skipped the exact layer. Each layer now has its own `try`.
- **custom-worker.ts** — `/api/*` answers that set no Cache-Control now get `no-store` (only
  /api/admin and ~7 routes had it; others return credentials). A route's own Cache-Control wins.

## Added
- `/.well-known/security.txt` (RFC 9116). Contact defaults to support@globproxy.com;
  override with the optional `SECURITY_CONTACT_EMAIL` secret. `Expires` rolls forward per request.

## Verified and ruled out
Percent-encoded and double-slash paths cannot bypass middleware or the Worker guard (checked on a
real Next 16 build); ssrfGuard handled 35 literal forms; edgeGuard origin/body rules correct.

## Left for the owner (not code)
- Repo is public and names the upstream supplier in ~50 files (lib/upstream.ts, supplier_* secret
  names, migration 0013, these FIX_PACKAGE notes). Making the repo private is the only complete fix.
- `workers_dev` / `preview_urls` still on (second origin outside zone WAF/bot rules). Remove once
  Paystack webhook URL and Supabase redirect list are confirmed to use the custom domain.
- CSP is report-only unless the CSP_MODE GitHub variable is `enforce`.
