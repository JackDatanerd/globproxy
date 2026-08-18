import { createClient } from '@/lib/supabase/server'
import { startEnrollment } from '@/lib/mfa'
import { NextResponse } from 'next/server'

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const result = await startEnrollment(user.id, user.email)
    // Covered by the "Own profile" RLS select policy — just this user's
    // own row. Only used so the setup screen can say *why* MFA is
    // mandatory in terms that make sense for the account reading it,
    // instead of a single hardcoded line naming every role that's ever
    // required to enroll (see mfa-setup/page.tsx).
    const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
    return NextResponse.json({ ...result, role: profile?.role ?? null })
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'Could not start MFA setup.' }, { status: 400 })
  }
}
