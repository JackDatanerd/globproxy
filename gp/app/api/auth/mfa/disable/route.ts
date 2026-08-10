import { createClient } from '@/lib/supabase/server'
import { disableMfa } from '@/lib/mfa'
import { clearMfaCookie } from '../_cookie'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { code } = await req.json().catch(() => ({}))
  if (!code || typeof code !== 'string') {
    return NextResponse.json({ error: 'Enter your current code to confirm.' }, { status: 400 })
  }

  try {
    await disableMfa(user.id, user.email, code)
    // Note for admin/reseller accounts: this doesn't grant lasting access
    // without MFA — middleware.ts re-routes them into mandatory setup on
    // the very next protected request, since profiles.mfa_enabled is now
    // false and their role requires it.
    const res = NextResponse.json({ success: true })
    return clearMfaCookie(res)
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'Could not disable MFA.' }, { status: 400 })
  }
}
