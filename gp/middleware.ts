import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          toSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()
  const path = request.nextUrl.pathname
  const isProtected = ['/dashboard', '/reseller', '/admin'].some(p => path.startsWith(p))

  if (isProtected && !user) {
    return NextResponse.redirect(new URL('/auth/login', request.url))
  }

  if (path.startsWith('/admin') && user) {
    const { data: profile } = await supabase.from('profiles').select('role, is_suspended').eq('id', user.id).single()
    if (profile?.role !== 'admin') return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  if (user) {
    const { data: profile } = await supabase.from('profiles').select('is_suspended').eq('id', user.id).single()
    if (profile?.is_suspended && !path.startsWith('/auth')) {
      await supabase.auth.signOut()
      return NextResponse.redirect(new URL('/auth/login?suspended=1', request.url))
    }
  }

  return response
}

export const config = { matcher: ['/dashboard/:path*', '/reseller/:path*', '/admin/:path*'] }
