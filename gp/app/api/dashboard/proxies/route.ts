import { createClient } from '@/lib/supabase/server'
import { createSubUser } from '@/lib/geonode'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const {
    label, gb_allocated, country, state, city,
    protocol = 'http', session_type = 'rotating',
    sticky_duration, endpoint_count = 1,
  } = body

  if (!gb_allocated || gb_allocated <= 0) {
    return NextResponse.json({ error: 'gb_allocated must be greater than 0' }, { status: 400 })
  }

  // 1. Check available bandwidth
  const { data: bw, error: bwErr } = await supabase
    .from('bandwidth_accounts')
    .select('available_gb, used_gb, total_gb')
    .eq('user_id', user.id)
    .single()

  if (bwErr || !bw) {
    return NextResponse.json({ error: 'Could not fetch bandwidth account' }, { status: 500 })
  }

  if (bw.available_gb < gb_allocated) {
    return NextResponse.json({
      error: `Insufficient bandwidth. You have ${bw.available_gb.toFixed(2)}GB available, requested ${gb_allocated}GB.`,
      available_gb: bw.available_gb,
    }, { status: 402 })
  }

  // 2. Increment used_gb immediately (available_gb is generated — never write it)
  const { error: deductErr } = await supabase
    .from('bandwidth_accounts')
    .update({ used_gb: bw.used_gb + gb_allocated })
    .eq('user_id', user.id)

  if (deductErr) {
    return NextResponse.json({ error: 'Failed to deduct bandwidth' }, { status: 500 })
  }

  // 3. Call Geonode — if it fails, insert as pending (not an error for the user)
  let gcred: { username: string; password: string; host: string; port: number; protocol: string }
  let status: 'active' | 'pending' = 'active'

  try {
    gcred = await createSubUser({
      label: label ?? `gp_${Date.now()}`,
      gb_limit: gb_allocated,
      country, state, city, protocol, session_type, sticky_duration,
    })
  } catch (e) {
    console.error('Geonode createSubUser error:', e)
    // Fallback — credential will be pending until manually activated
    gcred = {
      username: `gp_${Date.now()}`,
      password: Math.random().toString(36).slice(2, 18),
      host: 'proxy.globproxy.com',
      port: protocol === 'socks5' ? 7000 : 9000,
      protocol,
    }
    status = 'pending'
  }

  // 4. Insert credential row
  const { data: cred, error: insertErr } = await supabase
    .from('proxy_credentials')
    .insert({
      user_id: user.id,
      label: label || null,
      geonode_username: gcred.username,
      geonode_password: gcred.password,
      host: gcred.host,
      port: gcred.port,
      protocol,
      session_type,
      sticky_duration: sticky_duration ?? null,
      endpoint_count: endpoint_count ?? 1,
      gb_allocated,
      gb_used: 0,
      country: country ?? null,
      state: state ?? null,
      city: city ?? null,
      status,
      activated_at: status === 'active' ? new Date().toISOString() : null,
    })
    .select('id, status, geonode_username, host, port, protocol')
    .single()

  if (insertErr) {
    // Rollback the bandwidth deduction
    await supabase.from('bandwidth_accounts')
      .update({ used_gb: bw.used_gb })
      .eq('user_id', user.id)
    return NextResponse.json({ error: insertErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, id: cred.id, status: cred.status })
}
