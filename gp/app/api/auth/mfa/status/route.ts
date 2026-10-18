import { createClient, createAdminClient } from '@/lib/supabase/server'
import { checkVerifiedSession, countRemainingBackupCodes, getMfaCookieFromRequest } from '@/lib/mfa'
import { NextResponse } from 'next/server'

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = await createAdminClient()
  const { data: factor, error } = await admin
    .from('mfa_totp_factors').select('confirmed').eq('user_id', user.id).maybeSingle()

  // An infrastructure failure must NOT be reported as "not enrolled": the UI
  // would show a healthy, enrolled account an Enable button, and enrolling
  // would then fail with "already enabled".
  if (error) {
    console.error('[mfa/status] factor lookup failed', user.id, error)
    return NextResponse.json({ error: 'Could not load your two-factor status right now.' }, { status: 503 })
  }

  const confirmed = !!factor?.confirmed
  const verified = await checkVerifiedSession(getMfaCookieFromRequest(req), user.id)

  let backupRemaining: number | null = null
  if (confirmed) {
    try { backupRemaining = await countRemainingBackupCodes(user.id) } catch { backupRemaining = null }
  }

  return NextResponse.json({
    enrolled: !!factor,
    confirmed,
    verified,
    backup_codes_remaining: backupRemaining,
  })
}
