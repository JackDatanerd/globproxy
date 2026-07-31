import { createSubUser, deleteSubUser } from '@/lib/geonode'
import { buildProxyUsername, getProxyPort } from '@/lib/proxyEndpoint'
import { requireApiAccess } from '@/lib/apiAuth'
import { NextResponse } from 'next/server'

export async function GET(req: Request) {
  const auth = await requireApiAccess(req)
  if (!auth.ok) return auth.response
  const { user, supabase } = auth

  const { data } = await supabase
    .from('proxy_credentials')
    .select('id,label,status,gb_allocated,gb_used,country,state,city,asn,session_type,protocol,host,port,geonode_username,activated_at,created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  return NextResponse.json({ sub_users: data ?? [] })
}

export async function POST(req: Request) {
  const auth = await requireApiAccess(req)
  if (!auth.ok) return auth.response
  const { user, supabase } = auth

  const body = await req.json()
  const { label, gb_allocated, country, state, city, asn, session_type = 'rotating', protocol = 'http', endpoint_count = 1 } = body

  if (!gb_allocated || gb_allocated <= 0) {
    return NextResponse.json({ error: 'gb_allocated is required and must be > 0' }, { status: 400 })
  }

  // Soft gate against purchased total — used_gb is updated only by the cron
  // usage-sync job now, not deducted here. See dashboard/proxies/route.ts
  // for the full rationale.
  const { data: bw } = await supabase
    .from('bandwidth_accounts')
    .select('available_gb, used_gb')
    .eq('user_id', user.id)
    .single()

  if ((bw?.available_gb ?? 0) < gb_allocated) {
    return NextResponse.json({ error: 'Insufficient bandwidth. Purchase more to continue.' }, { status: 402 })
  }

  let gcred: any = null
  let credStatus: 'active' | 'pending' = 'active'
  try {
    gcred = await createSubUser({ label: label ?? `api_${Date.now()}`, gb_limit: gb_allocated, country, state, city, protocol, session_type })
  } catch {
    credStatus = 'pending'
  }

  const { data: cred, error } = await supabase.from('proxy_credentials').insert({
    user_id: user.id, label, gb_allocated, country: country ?? null,
    state: state ?? null, city: city ?? null, asn: asn ?? null, session_type, protocol,
    endpoint_count: endpoint_count ?? 1,
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
