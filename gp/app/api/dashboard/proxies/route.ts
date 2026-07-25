import { createClient } from '@/lib/supabase/server'
import { createSubUser, deleteSubUser } from '@/lib/geonode'
import { NextResponse } from 'next/server'

function providerConfigured(): boolean {
  return !!(
    process.env.GEONODE_API_KEY &&
    process.env.GEONODE_RESELLER_ID
  )
}

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

  // 2. Deduct bandwidth immediately
  const { error: deductErr } = await supabase
    .from('bandwidth_accounts')
    .update({ used_gb: bw.used_gb + gb_allocated })
    .eq('user_id', user.id)

  if (deductErr) {
    return NextResponse.json({ error: 'Failed to deduct bandwidth' }, { status: 500 })
  }

  // 3. Attempt Geonode — only when provider is configured
  let gcred: Awaited<ReturnType<typeof createSubUser>> | null = null
  let status: 'active' | 'pending' = 'pending'

  if (providerConfigured()) {
    try {
      gcred = await createSubUser({
        label: label ?? `gp_${Date.now()}`,
        gb_limit: gb_allocated,
        country, state, city, protocol, session_type, sticky_duration,
      })
      status = 'active'
    } catch (e) {
      console.error('Geonode createSubUser error:', e)
      // Rollback bandwidth — don't create fake credentials
      await supabase.from('bandwidth_accounts')
        .update({ used_gb: bw.used_gb })
        .eq('user_id', user.id)
      return NextResponse.json({
        error: 'Failed to provision proxy session. Your bandwidth has not been deducted. Please try again.',
      }, { status: 500 })
    }
  }

  // 4. Insert credential row
  const { data: cred, error: insertErr } = await supabase
    .from('proxy_credentials')
    .insert({
      user_id: user.id,
      label: label || null,
      geonode_sub_user_id: gcred?.geonode_sub_user_id ?? null, // required for usage/delete
      geonode_username: gcred?.username ?? null,
      geonode_password: gcred?.password ?? null,
      host: gcred?.host ?? null,
      port: gcred?.port ?? null,
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
    .select('id, status')
    .single()

  if (insertErr) {
    // Rollback bandwidth deduction
    await supabase.from('bandwidth_accounts')
      .update({ used_gb: bw.used_gb })
      .eq('user_id', user.id)
    // Clean up the real Geonode sub-user we just created — otherwise it's
    // orphaned on Geonode's side with no local record and no way to find it.
    if (gcred) {
      await deleteSubUser(gcred.geonode_sub_user_id).catch((e) =>
        console.error('Failed to clean up orphaned Geonode sub-user', gcred?.geonode_sub_user_id, e)
      )
    }
    return NextResponse.json({ error: insertErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, id: cred.id, status: cred.status })
}
