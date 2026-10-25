import { authorizeAdmin, readJson, badRequest, isUuid } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { providerConfigured, subUserExists } from '@/lib/credentials'
import { dispatchWebhook } from '@/lib/webhooks'
import { NextResponse } from 'next/server'

// Remediation for an ACTIVE session whose proxy no longer exists upstream
// (proxy_credentials.upstream_missing_since is set by the usage sync, which also e-mails the
// admin "re-provision or refund them from the admin panel" — this is that panel action).
//
//   reprovision  the session becomes PENDING with what it has left (allocated minus used);
//                the normal provisioning pipeline builds a fresh proxy, and the customer's
//                IP whitelist is restored from the local mirror. Consumed GB stay spent.
//   refund       the session is deleted and its unused allocation goes back to the
//                customer's balance (the consumed GB stay spent).
//
// Both refuse unless the supplier positively confirms the sub-user is gone (a 404 on the
// single-sub-user read). A listing that merely lags, or a supplier outage, changes nothing.
// Reseller-allocated sessions are refused by the database (their allocation is not the
// holder's to move) — handle those with the reseller.
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ credentialId?: string; action?: string }>(req)
  if (!body || !isUuid(body.credentialId)) return badRequest('Credential ID missing or invalid')
  if (body.action !== 'reprovision' && body.action !== 'refund') return badRequest("action must be 'reprovision' or 'refund'")
  if (!providerConfigured()) return NextResponse.json({ error: 'The proxy provider is not configured.' }, { status: 503 })

  const { data: cred } = await supabase
    .from('proxy_credentials')
    .select('id, user_id, label, status, created_by, upstream_sub_user_id, gb_allocated, gb_used, upstream_missing_since')
    .eq('id', body.credentialId).maybeSingle()
  if (!cred) return NextResponse.json({ error: 'Credential not found' }, { status: 404 })
  if (cred.status !== 'active' || !cred.upstream_sub_user_id) {
    return NextResponse.json({ error: `Only an active session with a proxy id can be remediated (status: ${cred.status})` }, { status: 409 })
  }
  if (cred.created_by) {
    return NextResponse.json({ error: 'This allocation was made by a reseller and cannot be moved from here. Handle it with the reseller.' }, { status: 409 })
  }

  // Positive confirmation that it is gone — and one last look at usage in case it is not.
  let exists: boolean
  try { exists = await subUserExists(cred.upstream_sub_user_id) }
  catch (e) {
    console.error('[admin credential-remediate] could not confirm upstream state', cred.id, e)
    return NextResponse.json({ error: 'Could not confirm the proxy’s state with the provider. Nothing was changed — try again shortly.' }, { status: 502 })
  }
  if (exists) {
    await supabase.from('proxy_credentials').update({ upstream_missing_since: null }).eq('id', cred.id)
    return NextResponse.json({ error: 'The proxy exists at the provider after all (the listing lagged). Nothing was changed.' }, { status: 409 })
  }

  try {
    if (body.action === 'reprovision') {
      const { data, error } = await supabase.rpc('reprovision_credential', { p_credential_id: cred.id, p_live_used_gb: null })
      if (error) {
        const code = error.code
        if (code === 'P0004') return NextResponse.json({ error: 'Nothing is left on this session to re-provision — use Refund/clean-up instead.' }, { status: 409 })
        if (code === 'P0005' || code === '42501') return NextResponse.json({ error: error.message }, { status: 409 })
        throw error
      }
      await logAdminAction(supabase, { adminId, action: 'credential.reprovision', targetUserId: cred.user_id, targetRef: cred.id, details: data as any })
    } else {
      const { data, error } = await supabase.rpc('delete_own_credential', {
        p_credential_id: cred.id, p_user_id: cred.user_id, p_live_used_gb: null,
      })
      if (error) {
        if (error.code === 'P0002') return NextResponse.json({ error: 'Credential not found' }, { status: 404 })
        throw error
      }
      await logAdminAction(supabase, { adminId, action: 'credential.refund_missing_upstream', targetUserId: cred.user_id, targetRef: cred.id, details: data as any })
      await dispatchWebhook(cred.user_id, 'session_deleted', {
        credential_id: cred.id, label: cred.label, gb_allocated: Number(cred.gb_allocated),
        gb_used: Number((data as any)?.archived_gb ?? 0), gb_released: Number((data as any)?.released_gb ?? 0), source: 'admin',
      })
    }
  } catch (e: any) {
    console.error('[admin credential-remediate] failed', cred.id, e)
    return NextResponse.json({ error: 'The change could not be completed. Nothing was changed — try again.' }, { status: 500 })
  }
  return NextResponse.json({ success: true })
}
