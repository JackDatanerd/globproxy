# Edge & request pipeline — pass 11

## Bug 1: the session-refresh brake could be bypassed with a lightly altered cookie

`lib/sessionProbe.ts` decoded the `base64-` session cookie with `atob()` + `TextDecoder`, but
`@supabase/ssr` 0.6.1 uses its own, far more lenient decoder. Anything the probe could not decode
it reported as `unreadable` (no brake), while the server decoded it fine and called Supabase Auth
to refresh the session. Verified against the real client (supabase-js / auth-js 2.104.0): an
expired session cookie with a fake refresh token, altered by any of

- a trailing `=` / `==`, or one stray extra character (length 1 mod 4)
- an `=` anywhere inside the value
- a space, tab or newline anywhere (raw or percent-encoded)
- an overlong UTF-8 encoding of a JSON quote (`C0 A2`)

made `SESSION_REFRESH_RATE_LIMITER` skip the request while the server still hit
`/auth/v1/token?grant_type=refresh_token`. That is exactly the traffic the brake exists to stop:
made-up cookies using up Supabase's per-address refresh budget until real users' refreshes fail
with 429 and middleware answers 503 on every signed-in page.

### Fix
- `lib/sessionProbe.ts`: `b64urlDecode` is now a line-for-line port of the library's
  `stringFromBase64URL` (ignore ` \t\n\r=` anywhere, reject other characters, drop leftover bits,
  same UTF-8 state machine), so the two cannot disagree. Dependency-free, as before.
- `tests/session-probe-diff.test.mjs` (new): runs the probe and the real client on crafted and
  seeded-random cookies and fails if the server refreshes anything the probe did not report as
  `refresh`. Fails on the old code, passes now.

## Bug 2: over budget, signed-in `/api/auth/*` routes were answered 401 instead of 429

`degradesToAnonymous()` (`custom-worker.ts`) treated every `/api/auth/*` path as a sign-in
request and stripped the session cookies. Routes that need the session (password, change-email,
reauth, sessions, signout-others, mfa/*) then saw "not signed in" and answered 401, which the
client reads as an expired session.

### Fix
- Only `/api/auth/login`, `signup`, `reset`, `resend-confirmation` and `mfa/logout` (which reads
  the gp_mfa cookie, not the session) degrade to anonymous. Every other `/api/*` route gets the
  429 + `Retry-After: 60`, like the rest of the API.
- `tests/worker-edge.test.mjs`: new test covers both lists.

## Verified, no change needed
Middleware gate and matcher against encoded / double-slash / case / dot-segment paths (Next
16.2.12), OpenNext header stripping, the SSRF guard (~55 hostname and IP forms), CRON_SECRET
checks, rate-limit binding sync, edge-cache safety, inbound-email parsing.

Checks: `npm test` 168/168, `tsc --noEmit` clean, `check:cron`, `check:supplier` OK.
