import { requireApiAccess } from '@/lib/apiAuth'
import { listWhitelistedIps, addWhitelistedIp, removeWhitelistedIp } from '@/lib/geonode'
import { isValidIp, validateDescription, whitelistErrorResponse } from '@/lib/ipWhitelist'
import { NextResponse } from 'next/server'
import type { ApiAuthResult } from '@/lib/apiAuth'

// Mirrors app/api/dashboard/proxies/[id]/whitelist/route.ts. Any owner
// (self-created or reseller-allocated) can manage their own credential's
// whitelist via the API too, same as the dashboard — locking a
// credential to specific source IPs doesn't reverse anything a reseller
// paid for, unlike delete/topup above.
async function loadOwnedCredential(supabase: Extract<ApiAuthResult, { ok: true }>['supabase'], id: string, userId: string) {
  const { data: cred } = await supabase
    .from('proxy_credentials')
    .select('id, user_id, geonode_sub_user_id')
    .eq('id', id)
    .eq('user_id', userId)
    .single()
  return cred
}

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAccess(req)
  if (!auth.ok) return auth.response
  const { user, supabase } = auth

  try {
    const { id } = await context.params
    const cred = await loadOwnedCredential(supabase, id, user.id)
    if (!cred) return NextResponse.json({ error: 'Sub-user not found' }, { status: 404 })

    if (!cred.geonode_sub_user_id) {
      return NextResponse.json({ ips: [], provisioning: true })
    }

    const ips = await listWhitelistedIps(cred.geonode_sub_user_id)
    return NextResponse.json({ ips })
  } catch (e) {
    return whitelistErrorResponse(e)
  }
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAccess(req)
  if (!auth.ok) return auth.response
  const { user, supabase } = auth

  try {
    const { id } = await context.params
    const body = await req.json().catch(() => ({}))
    const ip = typeof body?.ip === 'string' ? body.ip.trim() : ''
    const description = typeof body?.description === 'string' ? body.description.trim() : ''

    if (!isValidIp(ip)) {
      return NextResponse.json({ error: `"${ip}" is not a valid IPv4 or IPv6 address.` }, { status: 400 })
    }
    const descError = validateDescription(description)
    if (descError) return NextResponse.json({ error: descError }, { status: 400 })

    const cred = await loadOwnedCredential(supabase, id, user.id)
    if (!cred) return NextResponse.json({ error: 'Sub-user not found' }, { status: 404 })
    if (!cred.geonode_sub_user_id) {
      return NextResponse.json({ error: 'This sub-user is still being provisioned — try again shortly.' }, { status: 409 })
    }

    const ips = await addWhitelistedIp(cred.geonode_sub_user_id, ip, description)
    return NextResponse.json({ ips }, { status: 201 })
  } catch (e) {
    return whitelistErrorResponse(e)
  }
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAccess(req)
  if (!auth.ok) return auth.response
  const { user, supabase } = auth

  try {
    const { id } = await context.params
    const url = new URL(req.url)
    const ip = (url.searchParams.get('ip') || '').trim()

    if (!isValidIp(ip)) {
      return NextResponse.json({ error: `"${ip}" is not a valid IPv4 or IPv6 address.` }, { status: 400 })
    }

    const cred = await loadOwnedCredential(supabase, id, user.id)
    if (!cred) return NextResponse.json({ error: 'Sub-user not found' }, { status: 404 })
    if (!cred.geonode_sub_user_id) {
      return NextResponse.json({ error: 'This sub-user is still being provisioned — try again shortly.' }, { status: 409 })
    }

    const ips = await removeWhitelistedIp(cred.geonode_sub_user_id, ip)
    return NextResponse.json({ ips })
  } catch (e) {
    return whitelistErrorResponse(e)
  }
}
