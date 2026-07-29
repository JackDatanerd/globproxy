import { createAdminClient } from '@/lib/supabase/server'
import { getSubUserUsage } from '@/lib/geonode'
import { NextResponse } from 'next/server'

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await createAdminClient()
  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Check api_access
  const { data: profile } = await supabase
    .from('profiles').select('role, api_access').eq('id', user.id).single()
  if (profile?.role === 'user' || (!profile?.api_access && profile?.role !== 'admin')) {
    return NextResponse.json(
      { error: 'API access is not enabled for your account. Apply at globproxy.com/reseller.' },
      { status: 403 }
    )
  }

  const { id } = await context.params

  const { data: cred } = await supabase
    .from('proxy_credentials')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .single()

  if (!cred) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  let usedGb = cred.gb_used ?? 0
  if (cred.status === 'active' && cred.geonode_sub_user_id) {
    try {
      // Geonode's usage endpoint takes the sub-user ID, not the username —
      // see lib/bandwidth.ts / cron usage-sync for the same fix already
      // applied there.
      usedGb = await getSubUserUsage(cred.geonode_sub_user_id)
      await supabase.from('proxy_credentials')
        .update({ gb_used: usedGb })
        .eq('id', cred.id)
    } catch {}
  }

  return NextResponse.json({
    id: cred.id,
    label: cred.label,
    status: cred.status,
    protocol: cred.protocol ?? 'http',
    session_type: cred.session_type,
    gb_allocated: cred.gb_allocated,
    gb_used: usedGb,
    gb_remaining: Math.max(0, cred.gb_allocated - usedGb),
    country: cred.country,
    state: cred.state,
    city: cred.city,
    host: cred.host,
    port: cred.port,
    username: cred.geonode_username,
  })
}
