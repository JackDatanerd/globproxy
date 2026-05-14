import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const type = searchParams.get('type')
  const next = searchParams.get('next') ?? '/dashboard'

  if (code) {
    const s = await createClient()
    const { error } = await s.auth.exchangeCodeForSession(code)
    
    if (error) {
      return NextResponse.redirect(`${origin}/auth/login?error=link_expired`)
    }
  }

  // --- FIX: Prevent Hash Stripping on Password Reset ---
  if (type === 'recovery') {
    if (!code) {
      // If there's no code, it means we are using implicit flow with a #hash.
      // A standard 302 redirect will drop the hash. We use an HTML redirect instead.
      return new NextResponse(`
        <html><body><script>
          window.location.href = '${origin}/auth/update-password' + window.location.hash;
        </script></body></html>
      `, { headers: { 'Content-Type': 'text/html' } })
    }
    return NextResponse.redirect(`${origin}/auth/update-password`)
  }

  if (type === 'email_change') {
    return NextResponse.redirect(`${origin}/dashboard/settings?success=email_updated`)
  }

  if (type === 'invite') {
    return NextResponse.redirect(`${origin}/auth/update-password`)
  }

  return NextResponse.redirect(`${origin}${next}`)
}