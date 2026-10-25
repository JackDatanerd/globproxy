import { rejectCrossSite } from '@/lib/apiAuth'
import { createClient } from '@/lib/supabase/server'
import { regenerateBackupCodes, publicMfaError } from '@/lib/mfa'
import { requireActiveUser } from '@/lib/apiAuth'
import { rateLimited } from '@/lib/rateLimit'
import { recordAndNotify } from '@/lib/securityEvents'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const cross = rejectCrossSite(req)
  if (cross) return cross

  const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', 'mfa')
  if (limited) return limited

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const inactive = await requireActiveUser(user.id)
  if (inactive) return inactive

  const { code } = await req.json().catch(() => ({}))
  if (!code || typeof code !== 'string') {
    return NextResponse.json({ error: 'Enter your current code or a backup code to confirm.' }, { status: 400 })
  }

  try {
    const backup_codes = await regenerateBackupCodes(user.id, user.email, code, req)
    // Silently invalidates every existing backup code — same durable trip-wire.
    await recordAndNotify({ userId: user.id, event: 'mfa_backup_regenerated', req })
    return NextResponse.json({ backup_codes })
  } catch (e: any) {
    return NextResponse.json({ error: publicMfaError(e, 'Could not regenerate backup codes.') }, { status: 400 })
  }
}
