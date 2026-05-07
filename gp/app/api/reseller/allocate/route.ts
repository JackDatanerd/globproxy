import { createClient, createAdminClient } from '@/lib/supabase/server'
import { createSubUser } from '@/lib/geonode'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles').select('role').eq('id', user.id).single()
  if (!['reseller', 'admin'].includes(profile?.role ?? '')) {
    return NextResponse.json({ error: 'Reseller access required' }, { status: 403 })
  }

  const { recipient_id, label, gb_allocated, country, state, city } = await req.json()
  if (!recipient_id || !gb_allocated || gb_allocated <= 0) {
    return NextResponse.json({ error: 'recipient_id and gb_allocated are required' }, { status: 400 })
  }

  const adminSupabase = await createAdminClient()

  // Provision real credentials on Geonode immediately
  let gcred: any = null
  let credStatus: 'active' | 'pending' = 'active'
  try {
    gcred = await createSubUser({
      label: label ?? `reseller_${Date.now()}`,
      gb_limit: gb_allocated,
      country: country ?? undefined,
      state: state ?? undefined,
      city: city ?? undefined,
      protocol: 'http',
      session_type: 'rotating',
    })
  } catch (e) {
    console.error('Geonode createSubUser failed:', e)
    credStatus = 'pending'
  }

  // Insert credential for recipient — use adminSupabase to bypass RLS
  const { data: cred, error } = await adminSupabase
    .from('proxy_credentials')
    .insert({
      user_id: recipient_id,
      created_by: user.id,
      label,
      gb_allocated,
      gb_used: 0,
      country: country ?? null,
      state: state ?? null,
      city: city ?? null,
      protocol: 'http',
      session_type: 'rotating',
      endpoint_count: 1,
      status: credStatus,
      geonode_username: gcred?.username ?? null,
      geonode_password: gcred?.password ?? null,
      host: gcred?.host ?? 'proxy.globproxy.com',
      port: gcred?.port ?? 9000,
      activated_at: credStatus === 'active' ? new Date().toISOString() : null,
    })
    .select('id, status')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Record transfer as immediately active
  await adminSupabase.from('reseller_transfers').insert({
    reseller_id: user.id,
    recipient_id,
    credential_id: cred.id,
    gb_amount: gb_allocated,
    status: 'active',
    activated_at: new Date().toISOString(),
  })

  return NextResponse.json({ success: true, id: cred.id, status: cred.status })
}
