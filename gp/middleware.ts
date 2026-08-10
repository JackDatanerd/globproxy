import { createServerClient } from '@supabase/ssr'
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js'
import { NextResponse, type NextRequest } from 'next/server'

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
async function hasValidMfaSession(request: NextRequest, userId: string): Promise<boolean> {
  const token = request.cookies.get(MFA_COOKIE_NAME)?.value
  if (!token) return false
  const admin = createSupabaseJsClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
  const tokenHash = await sha256Hex(token)
  const { data } = await admin
    .from('mfa_verified_sessions')
    .select('user_id, expires_at')
    .eq('token_hash', tokenHash)
    .maybeSingle()
  if (!data || data.user_id !== userId) return false
  return new Date(data.expires_at).getTime() > Date.now()
}

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet: CookieToSet[]) => {
          toSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          toSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()
  const path = request.nextUrl.pathname

  const isProtected = ['/dashboard', '/reseller', '/admin'].some(p => path.startsWith(p))
  // Both the mandatory-setup and step-up-verify pages need a logged-in
  // user (they act on user.id) but must be reachable precisely *because*
  // the MFA gate below hasn't been satisfied yet — they're excluded from
  // that gate by path below to avoid redirecting a user into a loop of
  // "go verify" → "go verify" → ...
  const isMfaFlowPath = path === '/auth/mfa-setup' || path === '/auth/mfa-verify'

  // Not logged in — redirect to login
  if ((isProtected || isMfaFlowPath) && !user) {
    return NextResponse.redirect(new URL('/auth/login', request.url))
  }

  if (user) {
    // Single profile fetch covers the admin/reseller/suspension checks
    // and the MFA-required flag together.
    const { data: profile } = await supabase
      .from('profiles')
      .select('role, is_suspended, mfa_enabled')
      .eq('id', user.id)
      .single()

    // Suspended — sign out and redirect
    if (profile?.is_suspended && !path.startsWith('/auth')) {
      await supabase.auth.signOut()
      return NextResponse.redirect(new URL('/auth/login?suspended=1', request.url))
    }

    // Non-admin hitting /admin — send to dashboard
    if (path.startsWith('/admin') && profile?.role !== 'admin') {
      return NextResponse.redirect(new URL('/dashboard', request.url))
    }

    // Reseller-only routes
    if (path.startsWith('/reseller') && !['reseller', 'admin'].includes(profile?.role ?? '')) {
      return NextResponse.redirect(new URL('/dashboard', request.url))
    }

    // ── Mandatory MFA for admin & reseller ──────────────────────────
    // Applies to every protected path for these roles, not just /admin
    // and /reseller — a reseller's own bandwidth/billing lives under
    // /dashboard too, so gating only /reseller would leave that reachable
    // MFA-free.
    const mfaRequired = profile?.role === 'admin' || profile?.role === 'reseller'
    if (mfaRequired && isProtected && !isMfaFlowPath) {
      if (!profile?.mfa_enabled) {
        return NextResponse.redirect(new URL(`/auth/mfa-setup?next=${encodeURIComponent(path)}`, request.url))
      }
      const verified = await hasValidMfaSession(request, user.id)
      if (!verified) {
        return NextResponse.redirect(new URL(`/auth/mfa-verify?next=${encodeURIComponent(path)}`, request.url))
      }
    }
  }

  return response
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
  // /dashboard, /reseller, /admin inside the function body.
  matcher: ['/((?!api|_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|webmanifest|xml|txt)$).*)'],
}