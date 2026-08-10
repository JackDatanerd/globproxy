import { createClient, createAdminClient } from '@/lib/supabase/server'
import { mfaRequiredForRole, checkVerifiedSession, countRemainingBackupCodes, MFA_COOKIE_NAME } from '@/lib/mfa'
import { NextResponse } from 'next/server'

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = await createAdminClient()
  const [{ data: profile }, { data: factor }] = await Promise.all([
    admin.from('profiles').select('role, mfa_enabled').eq('id', user.id).single(),
    admin.from('mfa_totp_factors').select('confirmed').eq('user_id', user.id).maybeSingle(),
  ])

  const cookieToken = req.headers.get('cookie')
    ?.split(';')
    .map(c => c.trim())
    .find(c => c.startsWith(`${MFA_COOKIE_NAME}=`))
    ?.slice(MFA_COOKIE_NAME.length + 1)

  const verified = await checkVerifiedSession(cookieToken, user.id)
  const confirmed = !!factor?.confirmed

  return NextResponse.json({
    enrolled: !!factor,
    confirmed,
    required: mfaRequiredForRole(profile?.role),
    verified,
    backup_codes_remaining: confirmed ? await countRemainingBackupCodes(user.id) : null,
  })
}
