import { createClient } from '@/lib/supabase/server'
import { startEnrollment } from '@/lib/mfa'
import { rateLimited } from '@/lib/rateLimit'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', 'mfa')
  if (limited) return limited

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const result = await startEnrollment(user.id, user.email)
    return NextResponse.json(result)
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'Could not start MFA setup.' }, { status: 400 })
  }
}
