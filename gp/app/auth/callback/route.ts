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

  // Password reset
  if (type === 'recovery') {
    return NextResponse.redirect(`${origin}/auth/update-password`)
  }

  // Email change confirmation
  if (type === 'email_change') {
    return NextResponse.redirect(`${origin}/dashboard/settings?success=email_updated`)
  }

  // Invite acceptance
  if (type === 'invite') {
    return NextResponse.redirect(`${origin}/auth/update-password`)
  }

  // Generic next param or dashboard
  return NextResponse.redirect(`${origin}${next}`)
}