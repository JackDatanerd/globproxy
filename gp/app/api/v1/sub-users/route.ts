import { createAdminClient } from '@/lib/supabase/server'
import { createSubUser, deleteSubUser } from '@/lib/geonode'
import { buildProxyUsername, getProxyPort } from '@/lib/proxyEndpoint'
import { NextResponse } from 'next/server'

async function getAuthedUser(req: Request) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return null
  const supabase = await createAdminClient()
  const { data: { user } } = await supabase.auth.getUser(token)
  return user
}

const API_BLOCKED = NextResponse.json(
  { error: 'API access is not enabled for your account. Apply at globproxy.com/reseller.' },
  { status: 403 }
)

export async function GET(req: Request) {
  const user = await getAuthedUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await createAdminClient()
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, api_access')
    .eq('id', user.id)
    .single()

  // Must be reseller or admin AND have api_access enabled
  if (profile?.role === 'user') return API_BLOCKED
  if (!profile?.api_access && profile?.role !== 'admin') return API_BLOCKED

  const { data } = await supabase
    .from('proxy_credentials')
    .select('id,label,status,gb_allocated,gb_used,country,state,city,session_type,protocol,host,port,geonode_username,activated_at,created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  return NextResponse.json({ sub_users: data ?? [] })
}

export async function POST(req: Request) {
  const user = await getAuthedUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await createAdminClient()
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, api_access')
    .eq('id', user.id)
    .single()

  if (profile?.role === 'user') return API_BLOCKED
  if (!profile?.api_access && profile?.role !== 'admin') return API_BLOCKED

  const body = await req.json()
  const { label, gb_allocated, country, state, city, session_type = 'rotating', protocol = 'http', endpoint_count = 1 } = body

  if (!gb_allocated || gb_allocated <= 0) {
    return NextResponse.json({ error: 'gb_allocated is required and must be > 0' }, { status: 400 })
  }

  const { data: bw } = await supabase
    .from('bandwidth_accounts')
    .select('available_gb, used_gb')
    .eq('user_id', user.id)
    .single()

  if ((bw?.available_gb ?? 0) < gb_allocated) {
    return NextResponse.json({ error: 'Insufficient bandwidth. Purchase more to continue.' }, { status: 402 })
  }

  // Deduct GB immediately
  await supabase.from('bandwidth_accounts')
    .update({ used_gb: (bw?.used_gb ?? 0) + gb_allocated })
    .eq('user_id', user.id)

  let gcred: any = null
  let credStatus: 'active' | 'pending' = 'active'
  try {
    gcred = await createSubUser({ label: label ?? `api_${Date.now()}`, gb_limit: gb_allocated, country, state, city, protocol, session_type })
  } catch {
    credStatus = 'pending'
  }

  const { data: cred, error } = await supabase.from('proxy_credentials').insert({
    user_id: user.id, label, gb_allocated, country: country ?? null,
    state: state ?? null, city: city ?? null, session_type, protocol,
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
    // Rollback
    await supabase.from('bandwidth_accounts').update({ used_gb: bw?.used_gb ?? 0 }).eq('user_id', user.id)
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
