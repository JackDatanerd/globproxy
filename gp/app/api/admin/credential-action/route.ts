import { authorizeAdmin, readJson, badRequest, isUuid } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { disableCredential, enableCredential } from '@/lib/adminProxy'
import { syncUserUsage } from '@/lib/usageSync'
import { NextResponse } from 'next/server'

// Per-credential kill switch. Until now the only way to stop one abusive
// credential was to suspend the customer's whole account (and that didn't
// stop live proxy traffic either). Disabling caps the Geonode sub-user at
// what it has already used and marks the credential 'suspended';
// enabling restores the limit from gb_allocated.
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ credentialId?: string; action?: string }>(req)
  if (!body || !isUuid(body.credentialId)) return badRequest('Credential ID missing or invalid')
  if (body.action !== 'disable' && body.action !== 'enable') return badRequest("action must be 'disable' or 'enable'")

  const { data: cred } = await supabase
    .from('proxy_credentials')
    .select('id, user_id, geonode_sub_user_id, gb_allocated, status, owner:user_id(is_suspended, is_deleted)')
    .eq('id', body.credentialId)
    .single()
  if (!cred) return NextResponse.json({ error: 'Credential not found' }, { status: 404 })
  const owner = cred.owner as any
  if (owner?.is_deleted) return NextResponse.json({ error: 'The owner of this credential has been deleted' }, { status: 409 })

  try {
    if (body.action === 'disable') {
      if (cred.status !== 'active') return NextResponse.json({ error: `Only an active credential can be disabled (status: ${cred.status})` }, { status: 409 })
      // Fold in usage since the last cron tick before the credential stops
      // being 'active' (the usage sync only walks active credentials).
      await syncUserUsage(cred.user_id).catch((e) => console.error('[credential-action] pre-disable usage sync failed', e))
      await disableCredential(supabase, cred)
    } else {
      if (cred.status !== 'suspended') return NextResponse.json({ error: `Only a suspended credential can be re-enabled (status: ${cred.status})` }, { status: 409 })
      if (owner?.is_suspended) return NextResponse.json({ error: 'The owner account is suspended — reinstate the account instead.' }, { status: 409 })
      await enableCredential(supabase, cred)
    }
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? 'Failed to update the credential' }, { status: 502 })
  }

  await logAdminAction(supabase, { adminId, action: body.action === 'disable' ? 'credential.disable' : 'credential.enable', targetUserId: cred.user_id, targetRef: cred.id })
  return NextResponse.json({ success: true })
}
