import { createClient } from '@/lib/supabase/server'
import { regenerateBackupCodes } from '@/lib/mfa'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { code } = await req.json().catch(() => ({}))
  if (!code || typeof code !== 'string') {
    return NextResponse.json({ error: 'Enter your current code or a backup code to confirm.' }, { status: 400 })
  }

  try {
    const backup_codes = await regenerateBackupCodes(user.id, user.email, code)
    return NextResponse.json({ backup_codes })
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'Could not regenerate backup codes.' }, { status: 400 })
  }
}
