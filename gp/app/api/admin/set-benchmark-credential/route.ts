import { createAdminClient } from '@/lib/supabase/server'
import { requireMfaVerified } from '@/lib/mfa'
import { NextResponse } from 'next/server'

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

    const { credentialId } = await req.json()
    if (!credentialId) return NextResponse.json({ error: 'Credential ID missing' }, { status: 400 })

    // Sanity-check it's a real, usable credential before saving — the
    // same checks runConfiguredBenchmark applies at run time, just
    // surfaced here as an immediate error instead of a silent skip on
    // the next cron run.
    const { data: cred } = await supabaseAdmin
      .from('proxy_credentials')
      .select('protocol, status')
      .eq('id', credentialId)
      .single()

    if (!cred) return NextResponse.json({ error: 'That credential does not exist' }, { status: 400 })
    if (cred.protocol !== 'http') return NextResponse.json({ error: 'Only http-protocol credentials are supported for benchmarking right now' }, { status: 400 })
    if (cred.status !== 'active') return NextResponse.json({ error: `That credential is not active (status: ${cred.status})` }, { status: 400 })

    const { error: updateErr } = await supabaseAdmin
      .from('platform_settings')
      .update({ value: credentialId, updated_at: new Date().toISOString() })
      .eq('key', 'benchmark_credential_id')

    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })

    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
