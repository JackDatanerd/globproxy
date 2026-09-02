import { createAdminClient } from '@/lib/supabase/server'
import { requireMfaVerified } from '@/lib/mfa'
import { runConfiguredBenchmark } from '@/lib/networkProbe'
import { NextResponse } from 'next/server'

// The admin-authenticated equivalent of manually curling
// /api/cron/benchmark with the cron secret — same underlying
// runConfiguredBenchmark, just reachable from a button in the dashboard
// instead of a terminal. This is the "run it once and watch it work
// before trusting an unattended schedule" step.
export async function POST(req: Request) {
  try {
    const token = req.headers.get('authorization')?.replace('Bearer ', '')
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const supabaseAdmin = await createAdminClient()
    const { data: { user } } = await supabaseAdmin.auth.getUser(token)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: adminProfile } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).single()
    if (adminProfile?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const mfaCheck = await requireMfaVerified(req, user.id)
    if (mfaCheck) return mfaCheck

    const result = await runConfiguredBenchmark(supabaseAdmin)
    return NextResponse.json(result)
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
