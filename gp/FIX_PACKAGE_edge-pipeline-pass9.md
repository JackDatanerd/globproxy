# Edge & request pipeline — pass 9

## Bug: the session-refresh brake could be bypassed with crafted cookies

`lib/sessionProbe.ts` re-implemented how the server reads the Supabase session cookie, and
differed from Next's cookie parser, `@supabase/ssr` (`combineChunks`) and auth-js
(`__loadSession`). Each difference let a request make the server call Supabase Auth's refresh
endpoint while `classifySession` answered "fresh" / "unreadable", so
`SESSION_REFRESH_RATE_LIMITER` never counted it. Verified against the real client:

| Cookie | old verdict | refresh calls to Supabase |
|---|---|---|
| expired `sb-…-auth-token` + junk `.0` chunk | unreadable | 1 |
| expired `.0` + junk after a gap (`.2`) | unreadable | 1 |
| same name twice, fresh first, expired last | fresh | 1 |
| `expires_at` as the string `"1"` + future JWT `exp` | fresh | 1 |

Reverse case: a duplicate with the expired one first made a legitimate user look "refresh".

### Fix
- `classifySession` now mirrors the real readers: Next's parser (`; *` split, last duplicate wins,
  undecodable values skipped), ssr's exact-cookie-else-consecutive-chunks rule, auth-js's
  validity (`access_token`/`refresh_token`/`expires_at` keys) and expiry expression
  (`expires_at ? expires_at*1000 - now < 90s : false`, JS coercion, no JWT fallback).
- New `sessionKeyFromUrl()`; the Worker passes `env.NEXT_PUBLIC_SUPABASE_URL` so only the key the
  server actually reads is judged (falls back to every `sb-*-auth-token` if it can't be derived).
- Tests: `tests/edge-pipeline.test.mjs` (mirror cases; the "JWT-only is read" expectation was
  wrong and is now "unreadable"), `tests/worker-edge.test.mjs` (crafted cookies are still braked).

Files: `lib/sessionProbe.ts`, `custom-worker.ts`, two test files.
