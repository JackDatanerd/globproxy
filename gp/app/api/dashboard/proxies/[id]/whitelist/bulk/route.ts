import { createClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { bulkAddWhitelistedIps, bulkRemoveWhitelistedIps } from '@/lib/geonode'
import { isValidIp, validateDescription, whitelistErrorResponse, MAX_BULK_ITEMS } from '@/lib/ipWhitelist'
import { NextResponse } from 'next/server'

async function loadOwnedCredential(supabase: Awaited<ReturnType<typeof createClient>>, id: string, userId: string) {
  const { data: cred } = await supabase
    .from('proxy_credentials')
    .select('id, user_id, geonode_sub_user_id')
    .eq('id', id)
    .eq('user_id', userId)
    .single()
  return cred
}

// Bulk add — mirrors POST /whitelisted-ips/bulk-create. Kept as a
// separate route (rather than overloading the single-IP POST above with
// an "array or object" body) so each endpoint's request/response shape
// matches its Geonode counterpart 1:1.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended

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
  if (!cred) return NextResponse.json({ error: 'Credential not found' }, { status: 404 })
  if (!cred.geonode_sub_user_id) {
    return NextResponse.json({ error: 'This credential is still being provisioned — try again shortly.' }, { status: 409 })
  }

  try {
    const ips = await bulkAddWhitelistedIps(cred.geonode_sub_user_id, items)
    return NextResponse.json({ ips }, { status: 201 })
  } catch (e) {
    return whitelistErrorResponse(e)
  }
}

// Bulk delete — mirrors POST /whitelisted-ips/bulk-delete. This is
// deliberately a POST-shaped body (not query params) so it can carry an
// arbitrary-length IP list; Geonode's own bulk-delete endpoint is a POST
// for the same reason despite being a delete operation.
export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended

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
  if (!cred) return NextResponse.json({ error: 'Credential not found' }, { status: 404 })
  if (!cred.geonode_sub_user_id) {
    return NextResponse.json({ error: 'This credential is still being provisioned — try again shortly.' }, { status: 409 })
  }

  try {
    const result = await bulkRemoveWhitelistedIps(cred.geonode_sub_user_id, ips)
    return NextResponse.json({ ips: result })
  } catch (e) {
    return whitelistErrorResponse(e)
  }
}
