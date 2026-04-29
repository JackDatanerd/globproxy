import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/server'
import { createSubUser } from '@/lib/geonode'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const {
    label,
    country,
    state,
    city,
    protocol = 'http',
    session_type = 'rotating',
    sticky_duration,
    endpoint_count = 1,
    gb_allocated,
  } = await req.json()

  if (!gb_allocated || gb_allocated <= 0) {
    return NextResponse.json({ error: 'gb_allocated is required and must be > 0' }, { status: 400 })
  }

  const admin = await createAdminClient()

  // Check available GB
  const { data: bw } = await admin
    .from('bandwidth_accounts')
    .select('available_gb, used_gb')
    .eq('user_id', user.id)
    .single()

  if ((bw?.available_gb ?? 0) < gb_allocated) {
    return NextResponse.json({ error: 'Insufficient bandwidth. Purchase more to continue.' }, { status: 402 })
  }

  // Deduct GB
  await admin
    .from('bandwidth_accounts')
    .update({ used_gb: (bw?.used_gb ?? 0) + gb_allocated })
    .eq('user_id', user.id)

  // Provision on Geonode
  let gcred = null
  try {
    gcred = await createSubUser({
      label: label ?? `gp_${Date.now()}`,
      gb_limit: gb_allocated,
      country: country ?? undefined,
      state: state ?? undefined,
      city: city ?? undefined,
      protocol,
    })
  } catch (e) {
    console.error('Geonode provisioning error:', e)
  }

  const port = protocol === 'socks5' ? 7000 : 9000

  const { data: cred, error } = await admin
    .from('proxy_credentials')
    .insert({
      user_id: user.id,
      label: label ?? null,
      gb_allocated,
      country: country ?? null,
      state: state ?? null,
      city: city ?? null,
      protocol,
      session_type,
      sticky_duration: session_type === 'sticky' ? (sticky_duration ?? 10) : null,
      endpoint_count: endpoint_count ?? 1,
      status: gcred ? 'active' : 'pending',
      geonode_username: gcred?.username ?? null,
      geonode_password: gcred?.password ?? null,
      host: gcred?.host ?? 'proxy.globproxy.com',
      port: gcred?.port ?? port,
      activated_at: gcred ? new Date().toISOString() : null,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, id: cred.id }, { status: 201 })
}
