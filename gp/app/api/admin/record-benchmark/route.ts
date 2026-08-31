import { createAdminClient } from '@/lib/supabase/server'
import { requireMfaVerified } from '@/lib/mfa'
import { NextResponse } from 'next/server'

// v1 data source for the public /status page: an admin (or, once wired
// up, the 'benchmark' cron task — see app/api/cron/[task]/route.ts)
// records a measurement here. Same Bearer-token + MFA-gated admin
// pattern as every other /api/admin/* route.
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

    const { targetLabel, successRate, avgLatencyMs, sampleSize, notes } = await req.json()

    if (!targetLabel || typeof successRate !== 'number' || successRate < 0 || successRate > 100) {
      return NextResponse.json({ error: 'targetLabel and a successRate (0-100) are required' }, { status: 400 })
    }

    const { error: insertErr } = await supabaseAdmin.from('network_benchmarks').insert({
      target_label: targetLabel,
      success_rate: successRate,
      avg_latency_ms: avgLatencyMs ?? null,
      sample_size: sampleSize ?? 0,
      notes: notes ?? null,
    })

    if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 })

    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
