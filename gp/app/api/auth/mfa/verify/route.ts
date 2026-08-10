import { createClient } from '@/lib/supabase/server'
import { verifyFactor } from '@/lib/mfa'
import { withMfaCookie } from '../_cookie'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { code } = await req.json().catch(() => ({}))
  if (!code || typeof code !== 'string') {
    return NextResponse.json({ error: 'Enter your 6-digit code or a backup code.' }, { status: 400 })
  }

  try {
    const { session_token, used_backup_code, backup_codes_remaining } = await verifyFactor(user.id, user.email, code)
    const res = NextResponse.json({ used_backup_code, backup_codes_remaining })
    return withMfaCookie(res, session_token)
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'Could not verify code.' }, { status: 400 })
  }
}
