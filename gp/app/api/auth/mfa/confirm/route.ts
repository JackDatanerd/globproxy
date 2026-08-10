import { createClient } from '@/lib/supabase/server'
import { confirmEnrollment } from '@/lib/mfa'
import { withMfaCookie } from '../_cookie'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { code } = await req.json().catch(() => ({}))
  if (!code || typeof code !== 'string') {
    return NextResponse.json({ error: 'Enter the 6-digit code from your authenticator app.' }, { status: 400 })
  }

  try {
    const { backup_codes, session_token } = await confirmEnrollment(user.id, user.email, code)
    const res = NextResponse.json({ backup_codes })
    return withMfaCookie(res, session_token)
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'Could not confirm code.' }, { status: 400 })
  }
}
