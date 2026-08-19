import { requireApiAccess } from '@/lib/apiAuth'
import { bulkAddWhitelistedIps, bulkRemoveWhitelistedIps } from '@/lib/geonode'
import { isValidIp, validateDescription, whitelistErrorResponse, MAX_BULK_ITEMS } from '@/lib/ipWhitelist'
import { NextResponse } from 'next/server'
import type { ApiAuthResult } from '@/lib/apiAuth'

// Mirrors app/api/dashboard/proxies/[id]/whitelist/bulk/route.ts.
async function loadOwnedCredential(supabase: Extract<ApiAuthResult, { ok: true }>['supabase'], id: string, userId: string) {
  const { data: cred } = await supabase
    .from('proxy_credentials')
    .select('id, user_id, geonode_sub_user_id')
    .eq('id', id)
    .eq('user_id', userId)
    .single()
  return cred
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAccess(req)
  if (!auth.ok) return auth.response
  const { user, supabase } = auth

  try {
    const { id } = await context.params
    const body = await req.json().catch(() => ({}))
    const rawItems = Array.isArray(body?.items) ? body.items : null

    if (!rawItems || rawItems.length === 0) {
      return NextResponse.json({ error: 'items must be a non-empty array of { ip, description }.' }, { status: 400 })
    }
    if (rawItems.length > MAX_BULK_ITEMS) {
      return NextResponse.json({ error: `Max ${MAX_BULK_ITEMS} IPs per bulk request.` }, { status: 400 })
    }

    const items: { ip: string; description: string }[] = []
    for (const raw of rawItems) {
      const ip = typeof raw?.ip === 'string' ? raw.ip.trim() : ''
      const description = typeof raw?.description === 'string' ? raw.description.trim() : ''
      if (!isValidIp(ip)) {
        return NextResponse.json({ error: `"${ip || '(empty)'}" is not a valid IPv4 or IPv6 address.` }, { status: 400 })
      }
      const descError = validateDescription(description)
      if (descError) return NextResponse.json({ error: `${ip}: ${descError}` }, { status: 400 })
      items.push({ ip, description })
    }

    const cred = await loadOwnedCredential(supabase, id, user.id)
    if (!cred) return NextResponse.json({ error: 'Sub-user not found' }, { status: 404 })
    if (!cred.geonode_sub_user_id) {
      return NextResponse.json({ error: 'This sub-user is still being provisioned — try again shortly.' }, { status: 409 })
    }

    const ips = await bulkAddWhitelistedIps(cred.geonode_sub_user_id, items)
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
    const body = await req.json().catch(() => ({}))
    const rawIps = Array.isArray(body?.ips) ? body.ips : null

    if (!rawIps || rawIps.length === 0) {
      return NextResponse.json({ error: 'ips must be a non-empty array.' }, { status: 400 })
    }
    if (rawIps.length > MAX_BULK_ITEMS) {
      return NextResponse.json({ error: `Max ${MAX_BULK_ITEMS} IPs per bulk request.` }, { status: 400 })
    }

    const ips: string[] = []
    for (const raw of rawIps) {
      const ip = typeof raw === 'string' ? raw.trim() : ''
      if (!isValidIp(ip)) {
        return NextResponse.json({ error: `"${ip || '(empty)'}" is not a valid IPv4 or IPv6 address.` }, { status: 400 })
      }
      ips.push(ip)
    }

    const cred = await loadOwnedCredential(supabase, id, user.id)
    if (!cred) return NextResponse.json({ error: 'Sub-user not found' }, { status: 404 })
    if (!cred.geonode_sub_user_id) {
      return NextResponse.json({ error: 'This sub-user is still being provisioned — try again shortly.' }, { status: 409 })
    }

    const result = await bulkRemoveWhitelistedIps(cred.geonode_sub_user_id, ips)
    return NextResponse.json({ ips: result })
  } catch (e) {
    return whitelistErrorResponse(e)
  }
}
