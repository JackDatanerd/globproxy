import { createSubUser, deleteSubUser } from '@/lib/geonode'
import { buildProxyUsername, getProxyPort, validateTargeting } from '@/lib/proxyEndpoint'
import { requireApiAccess } from '@/lib/apiAuth'
import { NextResponse } from 'next/server'

export async function GET(req: Request) {
  const auth = await requireApiAccess(req)
  if (!auth.ok) return auth.response
  const { user, supabase } = auth

  const { data } = await supabase
    .from('proxy_credentials')
    .select('id,label,status,gb_allocated,gb_used,country,state,city,asn,session_type,protocol,sticky_duration,host,port,geonode_username,activated_at,created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  // POST already returns the built, geo-targeted connection_username —
  // GET was previously only returning the raw geonode_username, which is
  // not directly usable for connections that specify targeting. Consumers
  // shouldn't have to reimplement buildProxyUsername() themselves.
  const sub_users = (data ?? []).map(c => ({
    ...c,
    connection_username: c.geonode_username ? buildProxyUsername(c.geonode_username, c) : null,
  }))

  return NextResponse.json({ sub_users })
}

export async function POST(req: Request) {
  const auth = await requireApiAccess(req)
  if (!auth.ok) return auth.response
  const { user, supabase } = auth

  const body = await req.json()
  const { label, gb_allocated, country, state, city, asn, session_type = 'rotating', protocol = 'http', endpoint_count = 1, sticky_duration } = body

  if (!gb_allocated || gb_allocated <= 0) {
    return NextResponse.json({ error: 'gb_allocated is required and must be > 0' }, { status: 400 })
  }

  const targetingError = validateTargeting({ country, state, city })
  if (targetingError) {
    return NextResponse.json({ error: targetingError }, { status: 400 })
  }

  // Reserve bandwidth atomically instead of soft-checking it — see
  // migration 0007 for the full rationale (a burst of creations could
  // previously each pass a plain "available_gb >= requested" check before
  // any of them actually landed).
  const { error: reserveErr } = await supabase.rpc('reserve_credential_bandwidth', {
    p_user_id: user.id,
    p_gb: gb_allocated,
  })
  if (reserveErr) {
    return NextResponse.json({ error: 'Insufficient bandwidth. Purchase more to continue.' }, { status: 402 })
  }

  let gcred: any = null
  let credStatus: 'active' | 'pending' = 'active'
  try {
    gcred = await createSubUser({ label: label ?? `api_${Date.now()}`, gb_limit: gb_allocated, country, state, city, protocol, session_type, sticky_duration })
  } catch {
    credStatus = 'pending'
  }

  const { data: cred, error } = await supabase.from('proxy_credentials').insert({
    user_id: user.id, label, gb_allocated, country: country ?? null,
    state: state ?? null, city: city ?? null, asn: asn ?? null, session_type, protocol,
    endpoint_count: endpoint_count ?? 1, sticky_duration: sticky_duration ?? null,
    status: credStatus,
    geonode_sub_user_id: gcred?.geonode_sub_user_id ?? null,
    geonode_username: gcred?.username ?? null,
    geonode_password: gcred?.password ?? null,
    host: gcred?.host ?? 'proxy.globproxy.com',
    port: gcred?.port ?? getProxyPort(protocol, session_type),
    activated_at: credStatus === 'active' ? new Date().toISOString() : null,
  }).select().single()

  if (error) {
    if (gcred) {
      await deleteSubUser(gcred.geonode_sub_user_id).catch((e) =>
        console.error('Failed to clean up orphaned Geonode sub-user', gcred?.geonode_sub_user_id, e)
      )
    }
    // Give back the reservation — nothing was actually persisted.
    const { error: releaseErr } = await supabase.rpc('release_credential_bandwidth', { p_user_id: user.id, p_gb: gb_allocated })
    if (releaseErr) console.error('Failed to release bandwidth reservation after insert failure:', releaseErr)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    id: cred.id, label: cred.label, status: cred.status,
    host: cred.host, port: cred.port,
    username: cred.geonode_username, // raw Geonode sub-user account name
    // The username to actually use in your proxy connection — includes
    // country/state/city/session targeting encoded per Geonode's format.
    // For sticky sessions, generate a fresh session id per connection
    // yourself rather than reusing this one indefinitely: buildProxyUsername
    // logic is in lib/proxyEndpoint.ts if you need to construct more.
    connection_username: cred.geonode_username
      ? buildProxyUsername(cred.geonode_username, cred)
      : null,
    gb_allocated: cred.gb_allocated, country: cred.country,
  }, { status: 201 })
}
