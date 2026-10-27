# Edge & request pipeline — pass 10

## Bug 1: an undecodable session cookie meant a permanent 503 (and 500s) for that browser

When `sb-<ref>-auth-token` starts with `base64-` but does not decode (characters outside the
base64url alphabet, or bytes that are not valid UTF-8 once the chunks are joined),
`@supabase/ssr` 0.6.1 / auth-js 2.104 make `auth.getUser()` **reject** rather than report "no
session". Verified against the real client and the real `middleware.ts`:

| Where | Before |
|---|---|
| `/dashboard`, `/admin`, `/reseller`, `/invoice` | 503 "Temporarily unavailable" on every request, cookie never cleared |
| `/` (`app/page.tsx`, no try/catch) | error page |
| `/api/*` routes that read the session | 500 |

Plain junk, truncated JSON and non-session JSON were already handled by the library (signed
out, cookie cleared); only the decode failure escaped. Signing in again overwrote the cookie, but
nothing said so.

### Fix
- `lib/sessionCookies.ts` (new): `brokenSessionCookieNames` mirrors ssr's `combineChunks` and uses
  the library's own `stringFromBase64URL`, so it cannot disagree with it about what is decodable.
- `middleware.ts`: such cookies are removed from the request before anything reads it and expired
  on every response (redirect, 503, pass-through). The visitor is simply signed out.
- `lib/supabase/server.ts`: `getAll` hides them, so routes and server components read "no session"
  instead of throwing. Middleware is what clears them in the browser.
- `lib/sessionProbe.ts`: comment corrected (the library does not always "drop" an unreadable value).

## Bug 2: Supabase session cookies had no `Secure` attribute

The library's default options omit it; every other cookie this app sets has it. Now `setAll` in
`middleware.ts` and `lib/supabase/server.ts` add `secure` in production
(`sessionCookieOptions`), and the browser client (`lib/supabase/client.ts`) passes
`cookieOptions.secure` when the page is https so its token-refresh rewrites keep the attribute.

## Bug 3: admin / reseller gates used `startsWith`

`/administrator` or `/reseller-program` would have been sent to `/dashboard` for a signed-in
non-admin while `isProtectedPath` treats them as public. Both now use whole-segment matching
(`isUnderPrefix` in `lib/protectedPaths.ts`).

## Tests
`tests/session-cookies.test.mjs` (+ helper `tests/session-cookies-diff.mjs`): helper unit cases;
600 random cookie jars compared with the real Supabase client (0 disagreements, and nothing throws
once cleaned); the real `middleware.ts` bundled and run against a stubbed Supabase (bad cookie →
login redirect / pass-through with the cookie expired, good session untouched, gate paths).
The two middleware tests fail on the old code.

No migration. `npm test` 151 pass, `tsc` clean, cron/supplier/api-docs checks OK.
