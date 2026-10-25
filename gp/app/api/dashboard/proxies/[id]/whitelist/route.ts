import { requireMfaVerified } from '@/lib/mfa'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { rateLimitedUser } from '@/lib/rateLimit'
import { requireActiveUser } from '@/lib/apiAuth'
import { listWhitelistedIps, addWhitelistedIp, removeWhitelistedIp } from '@/lib/geonode'
import { isValidIp, validateIpForAdd, validateDescription, notifyWhitelistChanged } from '@/lib/ipWhitelist'
import { mirrorWhitelist, whitelistFailure } from '@/lib/whitelistMirror'
import { NextResponse } from 'next/server'

// Shared ownership + provisioning lookup for every handler below. Not
// gated on `created_by` the way delete/topup are — unlike releasing
// bandwidth or bumping a cap, locking a credential down to specific
// source IPs doesn't reverse anything a reseller paid for, so any owner
// (self-created or reseller-allocated) can manage it on their own
// credential, same as sticky sessions.
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

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
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
  const cred = await loadOwnedCredential(supabase, id, user.id)
  if (!cred) return NextResponse.json({ error: 'Credential not found' }, { status: 404 })

  // A credential with no Geonode sub-user yet (still provisioning, or
  // Geonode was down at creation time) has nothing to list — return an
  // empty whitelist rather than an error so the tab doesn't show a scary
  // failure for a perfectly normal transient state.
  if (!cred.upstream_sub_user_id) {
    return NextResponse.json({ ips: [], provisioning: true })
  }

  try {
    const ips = await listWhitelistedIps(cred.upstream_sub_user_id)
    return NextResponse.json({ ips })
  } catch (e) {
    return whitelistFailure(e, cred.upstream_sub_user_id)
  }
}

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
  const ip = typeof body?.ip === 'string' ? body.ip.trim() : ''
  const description = typeof body?.description === 'string' ? body.description.trim() : ''

  const ipError = validateIpForAdd(ip)
  if (ipError) return NextResponse.json({ error: ipError }, { status: 400 })
  const descError = validateDescription(description)
  if (descError) return NextResponse.json({ error: descError }, { status: 400 })

  const cred = await loadOwnedCredential(supabase, id, user.id)
  if (!cred) return NextResponse.json({ error: 'Credential not found' }, { status: 404 })
  if (!cred.upstream_sub_user_id) {
    return NextResponse.json({ error: 'This credential is still being provisioned — try again shortly.' }, { status: 409 })
  }

  try {
    const ips = await addWhitelistedIp(cred.upstream_sub_user_id, ip, description)
    await mirrorWhitelist(await createAdminClient(), id, user.id, ips)
    await notifyWhitelistChanged(user.id, id, 'added', 1, 'dashboard')
    return NextResponse.json({ ips }, { status: 201 })
  } catch (e) {
    return whitelistFailure(e, cred.upstream_sub_user_id)
  }
}

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
  const url = new URL(req.url)
  const ip = (url.searchParams.get('ip') || '').trim()

  if (!isValidIp(ip)) {
    return NextResponse.json({ error: `"${ip}" is not a valid IPv4 or IPv6 address.` }, { status: 400 })
  }

  const cred = await loadOwnedCredential(supabase, id, user.id)
  if (!cred) return NextResponse.json({ error: 'Credential not found' }, { status: 404 })
  if (!cred.upstream_sub_user_id) {
    return NextResponse.json({ error: 'This credential is still being provisioned — try again shortly.' }, { status: 409 })
  }

  try {
    const ips = await removeWhitelistedIp(cred.upstream_sub_user_id, ip)
    await mirrorWhitelist(await createAdminClient(), id, user.id, ips)
    await notifyWhitelistChanged(user.id, id, 'removed', 1, 'dashboard')
    return NextResponse.json({ ips })
  } catch (e) {
    return whitelistFailure(e, cred.upstream_sub_user_id)
  }
}
