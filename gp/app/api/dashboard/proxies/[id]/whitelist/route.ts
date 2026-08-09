import { createClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { listWhitelistedIps, addWhitelistedIp, removeWhitelistedIp } from '@/lib/geonode'
import { isValidIp, validateDescription, whitelistErrorResponse } from '@/lib/ipWhitelist'
import { NextResponse } from 'next/server'

// Shared ownership + provisioning lookup for every handler below. Not
// gated on `created_by` the way delete/topup are — unlike releasing
// bandwidth or bumping a cap, locking a credential down to specific
// source IPs doesn't reverse anything a reseller paid for, so any owner
// (self-created or reseller-allocated) can manage it on their own
// credential, same as sticky sessions.
async function loadOwnedCredential(supabase: Awaited<ReturnType<typeof createClient>>, id: string, userId: string) {
  const { data: cred } = await supabase
    .from('proxy_credentials')
    .select('id, user_id, geonode_sub_user_id')
    .eq('id', id)
    .eq('user_id', userId)
    .single()
  return cred
}

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await context.params
  const cred = await loadOwnedCredential(supabase, id, user.id)
  if (!cred) return NextResponse.json({ error: 'Credential not found' }, { status: 404 })

  // A credential with no Geonode sub-user yet (still provisioning, or
  // Geonode was down at creation time) has nothing to list — return an
  // empty whitelist rather than an error so the tab doesn't show a scary
  // failure for a perfectly normal transient state.
  if (!cred.geonode_sub_user_id) {
    return NextResponse.json({ ips: [], provisioning: true })
  }

  try {
    const ips = await listWhitelistedIps(cred.geonode_sub_user_id)
    return NextResponse.json({ ips })
  } catch (e) {
    return whitelistErrorResponse(e)
  }
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended

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
  if (!cred) return NextResponse.json({ error: 'Credential not found' }, { status: 404 })
  if (!cred.geonode_sub_user_id) {
    return NextResponse.json({ error: 'This credential is still being provisioned — try again shortly.' }, { status: 409 })
  }

  try {
    const ips = await addWhitelistedIp(cred.geonode_sub_user_id, ip, description)
    return NextResponse.json({ ips }, { status: 201 })
  } catch (e) {
    return whitelistErrorResponse(e)
  }
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended

  const { id } = await context.params
  const url = new URL(req.url)
  const ip = (url.searchParams.get('ip') || '').trim()

  if (!isValidIp(ip)) {
    return NextResponse.json({ error: `"${ip}" is not a valid IPv4 or IPv6 address.` }, { status: 400 })
  }

  const cred = await loadOwnedCredential(supabase, id, user.id)
  if (!cred) return NextResponse.json({ error: 'Credential not found' }, { status: 404 })
  if (!cred.geonode_sub_user_id) {
    return NextResponse.json({ error: 'This credential is still being provisioned — try again shortly.' }, { status: 409 })
  }

  try {
    const ips = await removeWhitelistedIp(cred.geonode_sub_user_id, ip)
    return NextResponse.json({ ips })
  } catch (e) {
    return whitelistErrorResponse(e)
  }
}
