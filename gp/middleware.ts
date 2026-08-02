import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

type CookieToSet = {
  name: string
  value: string
  options?: Record<string, any>
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

  // Not logged in — redirect to login
  if (isProtected && !user) {
    return NextResponse.redirect(new URL('/auth/login', request.url))
  }

  if (user) {
    // Single profile fetch covers both admin check and suspension check
    const { data: profile } = await supabase
      .from('profiles')
      .select('role, is_suspended')
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