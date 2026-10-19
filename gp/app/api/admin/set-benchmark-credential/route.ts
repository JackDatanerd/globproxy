import { authorizeAdmin, readJson, badRequest, isUuid } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ credentialId?: string }>(req)
  if (!body || !isUuid(body.credentialId)) return badRequest('Credential ID missing or invalid')
  const credentialId = body.credentialId

  // Sanity-check it's a real, usable credential before saving — the same
  // checks runConfiguredBenchmark applies at run time, surfaced here as an
  // immediate error instead of a silent skip on the next cron run.
  const { data: cred } = await supabase
    .from('proxy_credentials')
    .select('protocol, status, user_id')
    .eq('id', credentialId)
    .single()
  if (!cred) return NextResponse.json({ error: 'That credential does not exist' }, { status: 400 })
  // The settings page only ever offers the admin's OWN credentials. The
  // route accepted any user's, which would have burned a customer's
  // bandwidth on every benchmark run.
  if (cred.user_id !== adminId) return NextResponse.json({ error: 'Only your own credentials can be used for benchmarking' }, { status: 403 })
  if (cred.protocol !== 'http') return NextResponse.json({ error: 'Only http-protocol credentials are supported for benchmarking right now' }, { status: 400 })
  if (cred.status !== 'active') return NextResponse.json({ error: `That credential is not active (status: ${cred.status})` }, { status: 400 })

  // upsert, not update: a missing platform_settings row used to make the
  // update match zero rows and report success while saving nothing.
  const { error } = await supabase
    .from('platform_settings')
    .upsert({ key: 'benchmark_credential_id', value: credentialId, updated_at: new Date().toISOString() }, { onConflict: 'key' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await logAdminAction(supabase, { adminId, action: 'benchmark.set_credential', targetRef: credentialId })
  return NextResponse.json({ success: true })
}
