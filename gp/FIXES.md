# GlobProxy — fix package 8

Not from an audit pass — this is the follow-up to the `refresh_token_already_used`
errors you saw in `wrangler tail` after restoring secrets.

## The bug

`middleware.ts`'s matcher only ran on `/dashboard`, `/reseller`, `/admin`.
`app/page.tsx` (the homepage) still calls `supabase.auth.getUser()` directly
just to decide whether the CTA should link to `/dashboard/buy` or
`/auth/signup` — and that call can trigger a refresh-token rotation. Only
middleware can write cookies back to the browser in Next.js; a plain Server
Component can't (that's what the `try { ... } catch { /* server component —
safe to ignore */ }` in `lib/supabase/server.ts` was silently swallowing).

So: a visitor with a session who loads the homepage gets their refresh
token rotated server-side, with nowhere to persist the new one back to
their browser. Their next homepage load sends the same, now-already-
consumed token → `Invalid Refresh Token: Already Used`, every time, on
that page, for that visitor, indefinitely. Non-fatal — `getUser()` just
falls back to treating them as logged out — but a permanent noisy failure,
and it means their homepage CTA silently defaults to the signed-out link
even though they do have a session.

## The fix

Widened the middleware matcher to run on page routes generally (not `/api`,
not static assets), matching Supabase's own documented pattern for Next.js
SSR — middleware needs to run wherever a session might get refreshed, since
it's the only layer that can actually persist the rotated cookie.

The existing redirect/suspension logic inside `middleware.ts` is untouched
— it's still scoped to `/dashboard`, `/reseller`, `/admin` internally, so
nothing about auth-gating behavior changes. `/api/*` is explicitly excluded
since API routes already do their own auth per-route (cookie or Bearer
token) and don't need this.

## No database migration needed

Single file, application code only.

## Verify after deploying

Log in, then navigate directly to the homepage (`/`) a couple of times.
`wrangler tail` should no longer show `refresh_token_already_used` for
those requests, and the homepage CTA should correctly link to
`/dashboard/buy` for a logged-in visitor instead of `/auth/signup`.
