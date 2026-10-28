import { requireMfaVerified } from '@/lib/mfa'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { rateLimitedUser } from '@/lib/rateLimit'
import { requireActiveUser } from '@/lib/apiAuth'
import { bulkAddWhitelistedIps, bulkRemoveWhitelistedIps } from '@/lib/upstream'
import { isValidIp, validateIpForAdd, validateDescription, notifyWhitelistChanged, MAX_BULK_ITEMS } from '@/lib/ipWhitelist'
import { mirrorWhitelist, whitelistFailure } from '@/lib/whitelistMirror'
import { isUuidString } from '@/lib/cursor'
import { NextResponse } from 'next/server'

async function loadOwnedCredential(_supabase: Awaited<ReturnType<typeof createClient>>, id: string, userId: string) {
  // Service role + an explicit user_id filter: customers can't SELECT the
  // upstream_* columns directly (migration 0059), and ownership is enforced here.
  const admin = await createAdminClient()
  // A malformed id is simply "not found" (and never reaches the uuid column); a database error
  // is NOT "not found" — it used to be swallowed into a 404 that told the customer their session
  // had vanished during a brief database blip.
  if (!isUuidString(id)) return null
  const { data: cred, error } = await admin
    .from('proxy_credentials')
    .select('id, user_id, upstream_sub_user_id')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new LookupError()
  return cred
}

class LookupError extends Error {}

// Bulk add — mirrors POST /whitelisted-ips/bulk-create. Kept as a
// separate route (rather than overloading the single-IP POST above with
// an "array or object" body) so each endpoint's request/response shape
// matches its upstream counterpart 1:1.
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

  let cred: Awaited<ReturnType<typeof loadOwnedCredential>>
  try { cred = await loadOwnedCredential(supabase, id, user.id) }
  catch { return NextResponse.json({ error: 'Could not load this session. Please try again.' }, { status: 503 }) }
  if (!cred) return NextResponse.json({ error: 'Credential not found' }, { status: 404 })
  if (!cred.upstream_sub_user_id) {
    return NextResponse.json({ error: 'This credential is still being provisioned — try again shortly.' }, { status: 409 })
  }

  try {
    const ips = await bulkAddWhitelistedIps(cred.upstream_sub_user_id, items)
    await mirrorWhitelist(await createAdminClient(), id, user.id, ips, cred.upstream_sub_user_id)
    await notifyWhitelistChanged(user.id, id, 'added', items.length, 'dashboard')
    return NextResponse.json({ ips }, { status: 201 })
  } catch (e) {
    return whitelistFailure(e, cred.upstream_sub_user_id)
  }
}

// Bulk delete — mirrors POST /whitelisted-ips/bulk-delete. This is
// deliberately a POST-shaped body (not query params) so it can carry an
// arbitrary-length IP list; upstream's own bulk-delete endpoint is a POST
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

  let cred: Awaited<ReturnType<typeof loadOwnedCredential>>
  try { cred = await loadOwnedCredential(supabase, id, user.id) }
  catch { return NextResponse.json({ error: 'Could not load this session. Please try again.' }, { status: 503 }) }
  if (!cred) return NextResponse.json({ error: 'Credential not found' }, { status: 404 })
  if (!cred.upstream_sub_user_id) {
    return NextResponse.json({ error: 'This credential is still being provisioned — try again shortly.' }, { status: 409 })
  }

  try {
    const result = await bulkRemoveWhitelistedIps(cred.upstream_sub_user_id, ips)
    await mirrorWhitelist(await createAdminClient(), id, user.id, result, cred.upstream_sub_user_id)
    await notifyWhitelistChanged(user.id, id, 'removed', ips.length, 'dashboard')
    return NextResponse.json({ ips: result })
  } catch (e) {
    return whitelistFailure(e, cred.upstream_sub_user_id)
  }
}
