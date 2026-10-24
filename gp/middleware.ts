import { createServerClient } from '@supabase/ssr'
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js'
import { NextResponse, type NextRequest } from 'next/server'
import { isAuthOutage } from '@/lib/authOutage'
import { buildCsp, cspHeaderName } from '@/lib/csp'
import { isProtectedPath } from '@/lib/protectedPaths'

type CookieToSet = {
  name: string
  value: string
  options?: Record<string, any>
}

// MFA constants duplicated from lib/mfa.ts rather than imported — that
// module pulls in otpauth + qrcode for the enrollment/QR-generation path,
// neither of which middleware (which runs on effectively every request,
// per the matcher below) has any reason to bundle. Only the cookie name
// and the hash-and-look-up shape are needed here.
const MFA_COOKIE_NAME = 'gp_mfa'

// Every Supabase call below sits on the request path of every page. Without
// a ceiling, a slow Supabase stalls every page view until the Worker itself
// gives up; with one, the failure is quick and handled (see the catch in
// middleware()).
// Same attributes lib/mfa's cookie is set with (app/api/auth/mfa/_cookie.ts), so
// the browser actually replaces it.
function clearMfaCookie(res: NextResponse): NextResponse {
  res.cookies.set(MFA_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })
  return res
}

// supabase-js's signOut() only drops the session cookies when the logout call
// succeeds (or fails with a 401/403/404). On a 5xx or a network failure it returns
// { error } and leaves the session in place, so a suspended or deleted account
// could be "signed out" in name only. Expiring every sb-* cookie ourselves makes the
// browser forget the session whatever the logout call did.
function expireSupabaseCookies(res: NextResponse, request: NextRequest): NextResponse {
  for (const { name } of request.cookies.getAll()) {
    if (!name.startsWith('sb-')) continue
    res.cookies.set(name, '', { path: '/', maxAge: 0 })
  }
  return res
}

// Forced sign-out for a suspended / deleted account. Never throws and never skips
// the cookie clearing: a failed or timed-out logout call is logged, and the caller
// still expires the browser's session and revokes the 2FA proofs.
async function endSession(supabase: ReturnType<typeof createServerClient>, userId: string): Promise<void> {
  try {
    const { error } = await withTimeout(supabase.auth.signOut(), 'auth.signOut')
    if (error) console.error('[middleware] signOut reported an error — clearing cookies locally', userId, error.message)
  } catch (e) {
    console.error('[middleware] signOut threw — clearing cookies locally', userId, e)
  }
  await revokeAllMfaSessions(userId)
}

const UPSTREAM_TIMEOUT_MS = 4000

class UpstreamTimeout extends Error {}

function withTimeout<T>(work: PromiseLike<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new UpstreamTimeout(`${label} timed out after ${UPSTREAM_TIMEOUT_MS}ms`)), UPSTREAM_TIMEOUT_MS)
  })
  return Promise.race([Promise.resolve(work), timeout]).finally(() => clearTimeout(timer))
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown }

// Turns a promise into one that never rejects, so work started early (and
// possibly abandoned by an early return) cannot surface as an unhandled
// rejection later.
function settle<T>(work: Promise<T>): Promise<Settled<T>> {
  return work.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error })
  )
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// mfa_verified_sessions has no client-facing RLS policy at all (see
// migration 0020) — the row-level user_id +'s hash lookup below is
// deliberately done with the service-role key, constructed directly
// rather than via lib/supabase/server.ts's createAdminClient() to keep
// this file's only dependency on Supabase the same @supabase/supabase-js
// import already used for the request-scoped ssr client above.
//
// THROWS when the lookup itself fails (the caller turns that into a 503).
// It used to return false, which sent the user to /auth/mfa-verify as if
// their session had expired — indistinguishable from a real expiry, and
// useless to someone whose verification page then hit the same outage.
async function hasValidMfaSession(token: string, userId: string): Promise<boolean> {
  const admin = createSupabaseJsClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
  const tokenHash = await sha256Hex(token)
  const { data, error } = await admin
    .from('mfa_verified_sessions')
    .select('user_id, expires_at')
    .eq('token_hash', tokenHash)
    .maybeSingle()
  if (error) {
    console.error('[mfa] hasValidMfaSession query failed — failing closed with a 503', userId, error)
    throw new Error(`mfa_verified_sessions lookup failed: ${error.message}`)
  }
  if (!data || data.user_id !== userId) return false
  return new Date(data.expires_at).getTime() > Date.now()
}

// A forced sign-out (suspended / deleted) must also end the account's 2FA
// proofs. Supabase's signOut() knows nothing about the separate gp_mfa
// session, so without this the browser stays "verified" and an account that is
// later reinstated skips its 2FA prompt. Best effort: it must never stop the
// sign-out itself.
async function revokeAllMfaSessions(userId: string): Promise<void> {
  try {
    const admin = createSupabaseJsClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )
    const { error } = await withTimeout(admin.from('mfa_verified_sessions').delete().eq('user_id', userId), 'mfa session revoke')
    if (error) console.error('[middleware] could not revoke mfa sessions', userId, error.message)
  } catch (e) {
    console.error('[middleware] mfa session revoke threw', userId, e)
  }
}

const UNAVAILABLE_HTML =
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Temporarily unavailable</title>' +
  '<body style="font-family:sans-serif;max-width:420px;margin:15vh auto;padding:0 24px;text-align:center;color:#111">' +
  '<h2>Temporarily unavailable</h2><p style="color:#555">We couldn\'t verify your account just now. Please refresh in a few seconds.</p></body>'

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname

  // '/invoice' added alongside '/dashboard'/'/reseller'/'/admin': it's an
  // order's billing/PII document, equivalent in sensitivity to what's
  // already on the (MFA-gated, for admin/reseller) /dashboard/billing
  // page — leaving it out of isProtected would let an admin/reseller
  // reach the same underlying order data at a URL the MFA gate below
  // never inspects, defeating the point of "mandatory for every
  // protected path" a few lines down.
  // Whole path segments (lib/protectedPaths.ts, shared with next.config.ts): '/admin' and
  // '/admin/x' are protected, '/administrator' is not.
  const isProtected = isProtectedPath(path)
  // Both the mandatory-setup and step-up-verify pages need a logged-in
  // user (they act on user.id) but must be reachable precisely *because*
  // the MFA gate below hasn't been satisfied yet — they're excluded from
  // that gate by path below to avoid redirecting a user into a loop of
  // "go verify" → "go verify" → ...
  const isMfaFlowPath = path === '/auth/mfa-setup' || path === '/auth/mfa-verify'
  const needsAuth = isProtected || isMfaFlowPath

  // The signed-in areas get a per-request nonce CSP (lib/csp.ts). Those pages are
  // per-user and never edge-cached, so a nonce costs nothing there, and it lets
  // the policy drop 'unsafe-inline' for scripts. Next reads the nonce from the
  // CSP header on the REQUEST and stamps it on its own scripts, so the header has
  // to be forwarded on the request as well as set on the response. Public pages
  // keep the static policy from next.config.ts (they are served from the edge
  // cache, where a per-request nonce cannot work).
  const nonce = isProtected ? btoa(crypto.randomUUID()) : null
  const nonceCsp = nonce ? buildCsp({ nonce }) : null
  const nextResponse = () => {
    if (!nonce || !nonceCsp) return NextResponse.next({ request })
    // Rebuilt from request.headers on every call, so cookies Supabase has just
    // written onto the request (setAll below) are not lost.
    const headers = new Headers(request.headers)
    headers.set(cspHeaderName(), nonceCsp)
    headers.set('x-nonce', nonce)
    // Where the person was going, for layouts that must send them through sign-in / 2FA and back.
    headers.set('x-return-path', request.nextUrl.pathname + request.nextUrl.search)
    const res = NextResponse.next({ request: { headers } })
    res.headers.set(cspHeaderName(), nonceCsp)
    return res
  }

  let response = nextResponse()

  // Anything returned from here on must carry the cookies Supabase just set
  // on `response` — a refreshed session after getUser(), or the deletions
  // from signOut(). A bare NextResponse drops them, which strands a user
  // whose refresh token was rotated (the next request replays a consumed
  // token and fails) and leaves a signed-out session cookie in the browser.
  // That applies to redirects AND to the 503 below: the 503 used to be built
  // bare, so a database hiccup landing on the very request that rotated the
  // token threw the new one away.
  const withSessionCookies = (res: NextResponse) => {
    response.cookies.getAll().forEach((c) => res.cookies.set(c))
    return res
  }
  const redirectTo = (url: URL) => withSessionCookies(NextResponse.redirect(url))

  // Plain 503, deliberately not a redirect to /auth/login: the login page
  // bounces signed-in users back to /dashboard, which would loop.
  //
  // `keepBrowserCookies` is for an auth-backend outage: when the refresh call
  // fails server-side, supabase-js can queue DELETIONS of the session cookies,
  // and copying those onto the 503 would sign the user out because of OUR
  // outage. In that case the response carries no cookie changes at all.
  const unavailable = (keepBrowserCookies = false) => {
    const res = new NextResponse(UNAVAILABLE_HTML, {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '5', 'Cache-Control': 'no-store' },
    })
    return keepBrowserCookies ? res : withSessionCookies(res)
  }

  try {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll: () => request.cookies.getAll(),
          setAll: (toSet: CookieToSet[]) => {
            toSet.forEach(({ name, value }) => request.cookies.set(name, value))
            response = nextResponse()
            toSet.forEach(({ name, value, options }) =>
              response.cookies.set(name, value, options)
            )
          },
        },
      }
    )

    const { data: { user }, error: authError } = await withTimeout(supabase.auth.getUser(), 'auth.getUser')

    // "No session" and "Supabase Auth could not be reached" both come back
    // with user === null. Treating the second as a logout bounces every
    // signed-in user to the login page during an outage. A real missing or
    // invalid session is a 4xx (AuthSessionMissingError and friends); network
    // failures, 5xx, 429 and an error answer with a non-JSON body (supabase-js's
    // AuthUnknownError, e.g. an HTML 500/52x page from the edge) are an outage.
    // See lib/authOutage.ts.
    const authOutage = isAuthOutage(authError)
    if (authOutage) {
      if (needsAuth) {
        console.error('[middleware] auth backend unreachable — returning 503 instead of treating the visitor as logged out', authError?.message)
        return unavailable(true)
      }
      // Public page during the outage: serve it, but never let the browser's
      // session cookies be cleared on the back of a failed refresh.
      return NextResponse.next()
    }

    // Where to come back to after signing in. Path + query, same-site only —
    // the login page and callback both re-validate it with safeNextPath().
    const here = path + request.nextUrl.search

    // Not logged in — redirect to login, remembering where they were headed.
    if (needsAuth && !user) {
      const loginUrl = new URL('/auth/login', request.url)
      if (isProtected) loginUrl.searchParams.set('next', here)
      return redirectTo(loginUrl)
    }

    if (user) {
      // The step-up lookup only matters for an account with MFA on, which we
      // don't know until the profile comes back — but when the browser holds a
      // verified-session cookie it is almost always going to be needed, so it
      // is started now and runs alongside the profile read instead of after
      // it. Wrapped so an abandoned result can never become an unhandled
      // rejection.
      const mfaToken = request.cookies.get(MFA_COOKIE_NAME)?.value
      const mfaLookup =
        isProtected && mfaToken
          ? settle(withTimeout(hasValidMfaSession(mfaToken, user.id), 'mfa session lookup'))
          : null

      // Single profile fetch covers the admin/reseller/suspension checks
      // and the MFA-required flag together.
      const { data: profile, error: profileError } = await withTimeout(
        supabase
          .from('profiles')
          .select('role, is_suspended, is_deleted, mfa_enabled')
          .eq('id', user.id)
          .maybeSingle(),
        'profiles lookup'
      )

      // Fail CLOSED. This query used to ignore its error, so any transient
      // failure left `profile` null — and every check below (deleted,
      // suspended, role gates, MFA step-up) is written as `profile?.x`, which
      // silently evaluates to "all clear". A hiccup therefore let suspended
      // and MFA-protected accounts straight through for that request. On a
      // protected path, an unreadable profile is a temporary outage, not a
      // pass.
      if (profileError && needsAuth) {
        console.error('[middleware] profile lookup failed — failing closed', user.id, profileError.message)
        return unavailable()
      }
      // Same rule for "no error, but no row": every check below would read an
      // absent profile as "not deleted, not suspended, MFA off". The API side
      // (requireActiveUser) already treats a missing profile as a failure;
      // the page side now agrees instead of waving the request through.
      if (!profile && !profileError && needsAuth) {
        console.error('[middleware] signed-in user has no profiles row — failing closed', user.id)
        return unavailable()
      }

      // Deleted — sign out and redirect. This is the actual enforcement
      // point referenced throughout the app (lib/apiAuth.ts,
      // app/dashboard/layout.tsx, app/reseller/layout.tsx, migration 0029's
      // own comments) as "middleware.ts's is_deleted check" — closing this
      // here, alongside is_suspended right below, is what makes every one
      // of /dashboard, /reseller, /admin, /invoice actually stop working
      // for a deleted account on its very next request, regardless of
      // whether the access token itself is technically still unexpired.
      // The layouts under /dashboard, /reseller and /admin repeat their own
      // role / MFA checks as a second backstop; this is what catches it
      // first, for every protected path at once.
      if (profile?.is_deleted && !path.startsWith('/auth')) {
        await endSession(supabase, user.id)
        return clearMfaCookie(expireSupabaseCookies(redirectTo(new URL('/auth/login?deleted=1', request.url)), request))
      }

      // Suspended — sign out and redirect
      if (profile?.is_suspended && !path.startsWith('/auth')) {
        await endSession(supabase, user.id)
        return clearMfaCookie(expireSupabaseCookies(redirectTo(new URL('/auth/login?suspended=1', request.url)), request))
      }

      // Non-admin hitting /admin — send to dashboard
      if (path.startsWith('/admin') && profile?.role !== 'admin') {
        return redirectTo(new URL('/dashboard', request.url))
      }

      // Reseller-only routes
      if (path.startsWith('/reseller') && !['reseller', 'admin'].includes(profile?.role ?? '')) {
        return redirectTo(new URL('/dashboard', request.url))
      }

      // ── MFA step-up ──────────────────────────────────────────────────
      // MFA is OPTIONAL for every role (admin and reseller included): the app
      // recommends it (see MfaRecommendBanner) but never forces enrollment.
      // What IS enforced is the other direction — once an account has turned
      // it on, a password alone no longer gets into any protected page: the
      // browser must hold a valid verified-session cookie, else it is sent to
      // /auth/mfa-verify.
      //
      // This only guards PAGES (the matcher excludes /api). Routes that can
      // spend money, mint credentials, move payouts, delete data or act as an
      // admin enforce the same rule themselves via requireMfaVerified() in
      // lib/mfa.ts — see that file. profiles.mfa_enabled is not user-writable
      // (migration 0039 pins it), so trusting it here is sound.
      if (isProtected && !isMfaFlowPath && profile?.mfa_enabled) {
        let verified = false
        if (mfaLookup) {
          const result = await mfaLookup
          if (!result.ok) throw result.error // → 503 via the catch below
          verified = result.value
        }
        if (!verified) {
          return redirectTo(new URL(`/auth/mfa-verify?next=${encodeURIComponent(here)}`, request.url))
        }
      }
    }

    return response
  } catch (e) {
    // A Supabase call timed out, threw, or the client could not be built
    // (e.g. missing env). Protected pages can't be served without knowing who
    // is asking, so they get the 503. Everything else — the marketing site,
    // pricing, docs, the login page itself — is public content and keeps
    // working, rendered as for a logged-out visitor, instead of the whole
    // site going down with the database.
    console.error('[middleware] upstream failure', path, e)
    return needsAuth ? unavailable() : response
  }
}

export const config = {
  // Runs on page routes generally (not /api, not static assets) so that any
  // route calling supabase.auth.getUser() — including Server Components like
  // app/page.tsx, which reads it just to pick the CTA link — gets its
  // rotated refresh-token cookie actually persisted back to the browser.
  // Server Components themselves can't write cookies (Next.js restriction);
  // only middleware can. Previously this only ran on /dashboard, /reseller,
  // /admin, so a visitor with a session who landed on the homepage first
  // would have their refresh token rotated server-side with nowhere to
  // write the new one back — their next homepage load would send the same
  // already-consumed token and fail with "Invalid Refresh Token: Already
  // Used" every time, on that page, indefinitely (non-fatal — getUser()
  // just falls back to null — but a permanent noisy failure for that
  // visitor). /api is excluded: API routes do their own auth (session
  // cookie or Bearer token per-route) and don't need middleware's
  // redirect/suspension logic, which stays exactly as before, scoped to
  // /dashboard, /reseller, /admin, /invoice inside the function body.
  //
  // `api` is matched as a whole path segment (api/ or a bare api), so a page
  // that merely STARTS with those letters ("/apiary", "/api-docs") is not
  // silently skipped. Static file types that never need a session (scripts,
  // styles, fonts, source maps, media) are excluded so they don't each pay
  // for an auth round trip — EXCEPT under the protected prefixes: a dynamic
  // segment can end in any extension (`/invoice/<id>.png`), and the extension
  // rule used to switch the auth and MFA gate off for such a URL. Nothing under
  // /dashboard, /reseller, /admin or /invoice is ever a static file.
  matcher: ['/((?!api/|api$|_next/static|_next/image|favicon\\.ico|(?!(?:dashboard|reseller|admin|invoice)(?:/|$)).*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|webmanifest|xml|txt|js|css|map|woff|woff2|ttf|otf|json|pdf|mp4|webm|html)$).*)'],
}
