import { createAdminClient } from '@/lib/supabase/server'
import { createSubUser } from '@/lib/geonode'
import { NextResponse } from 'next/server'

async function getUser(req: Request) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return null
  const supabase = await createAdminClient()
  const { data: { user } } = await supabase.auth.getUser(token)
  return user
}

export async function GET(req: Request) {
  const user = await getUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const supabase = await createAdminClient()
  const { data } = await supabase.from('proxy_credentials').select('id,label,status,gb_allocated,gb_used,country,city,session_type,host,port,geonode_username,activated_at,created_at').eq('user_id', user.id).order('created_at', { ascending: false })
  return NextResponse.json({ sub_users: data ?? [] })
}

export async function POST(req: Request) {
  const user = await getUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const supabase = await createAdminClient()

  // Resellers only
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (profile?.role === 'user') return NextResponse.json({ error: 'API access is available to resellers only. Apply at globproxy.com/auth/signup?role=reseller' }, { status: 403 })

  const body = await req.json()
  const { label, gb_allocated, country, city, session_type = 'rotating' } = body
  if (!gb_allocated || gb_allocated <= 0) return NextResponse.json({ error: 'gb_allocated is required and must be > 0' }, { status: 400 })

  const { data: bw } = await supabase.from('bandwidth_accounts').select('available_gb').eq('user_id', user.id).single()
  if ((bw?.available_gb ?? 0) < gb_allocated) return NextResponse.json({ error: 'Insufficient bandwidth. Purchase more to continue.' }, { status: 402 })

  // Deduct GB
  const { data: bwFull } = await supabase.from('bandwidth_accounts').select('used_gb').eq('user_id', user.id).single()
  await supabase.from('bandwidth_accounts').update({ used_gb: (bwFull?.used_gb ?? 0) + gb_allocated }).eq('user_id', user.id)

  // Provision on Geonode
  let gcred = null
  try { gcred = await createSubUser({ label: label ?? `api_${Date.now()}`, gb_limit: gb_allocated, country, city }) }
  catch (e) { console.error('Geonode error:', e) }

  const { data: cred, error } = await supabase.from('proxy_credentials').insert({
    user_id: user.id, label, gb_allocated, country: country ?? null, city: city ?? null, session_type,
    status: gcred ? 'active' : 'pending',
    geonode_username: gcred?.username ?? null,
    geonode_password: gcred?.password ?? null,
    host: gcred?.host ?? 'residential.geonode.com',
    port: gcred?.port ?? 9000,
    activated_at: gcred ? new Date().toISOString() : null,
  }).select().single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ id: cred.id, label: cred.label, status: cred.status, host: cred.host, port: cred.port, username: cred.geonode_username, gb_allocated: cred.gb_allocated, country: cred.country }, { status: 201 })
}
