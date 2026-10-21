import { requireMfaVerified } from '@/lib/mfa'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { rateLimitedUser } from '@/lib/rateLimit'
import { requireActiveUser } from '@/lib/apiAuth'
import { bulkAddWhitelistedIps, bulkRemoveWhitelistedIps } from '@/lib/geonode'
import { isValidIp, validateIpForAdd, validateDescription, whitelistErrorResponse, MAX_BULK_ITEMS } from '@/lib/ipWhitelist'
import { NextResponse } from 'next/server'

async function loadOwnedCredential(_supabase: Awaited<ReturnType<typeof createClient>>, id: string, userId: string) {
  // Service role + an explicit user_id filter: customers can't SELECT the
  // upstream_* columns directly (migration 0059), and ownership is enforced here.
  const admin = await createAdminClient()
  const { data: cred } = await admin
    .from('proxy_credentials')
    .select('id, user_id, upstream_sub_user_id')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()
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

  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock
  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended
  const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'whitelist')
  if (throttled) return throttled

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
    const ipError = validateIpForAdd(ip)
    if (ipError) return NextResponse.json({ error: `${ip || '(empty)'}: ${ipError}` }, { status: 400 })
    const descError = validateDescription(description)
    if (descError) return NextResponse.json({ error: `${ip}: ${descError}` }, { status: 400 })
    items.push({ ip, description })
  }

  const cred = await loadOwnedCredential(supabase, id, user.id)
  if (!cred) return NextResponse.json({ error: 'Credential not found' }, { status: 404 })
  if (!cred.upstream_sub_user_id) {
    return NextResponse.json({ error: 'This credential is still being provisioned — try again shortly.' }, { status: 409 })
  }

  try {
    const ips = await bulkAddWhitelistedIps(cred.upstream_sub_user_id, items)
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

  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock
  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended
  const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'whitelist')
  if (throttled) return throttled

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
  if (!cred.upstream_sub_user_id) {
    return NextResponse.json({ error: 'This credential is still being provisioned — try again shortly.' }, { status: 409 })
  }

  try {
    const result = await bulkRemoveWhitelistedIps(cred.upstream_sub_user_id, ips)
    return NextResponse.json({ ips: result })
  } catch (e) {
    return whitelistErrorResponse(e)
  }
}
