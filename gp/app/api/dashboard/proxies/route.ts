import { createClient } from '@/lib/supabase/server'
import { createSubUser, deleteSubUser } from '@/lib/geonode'
import { validateTargeting } from '@/lib/proxyEndpoint'
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
    label, gb_allocated, country, state, city, asn,
    protocol = 'http', session_type = 'rotating',
    sticky_duration, endpoint_count = 1,
  } = body

  if (!gb_allocated || gb_allocated <= 0) {
    return NextResponse.json({ error: 'gb_allocated must be greater than 0' }, { status: 400 })
  }

  const targetingError = validateTargeting({ country, state, city })
  if (targetingError) {
    return NextResponse.json({ error: targetingError }, { status: 400 })
  }

  // 1. Reserve bandwidth atomically. Previously this only soft-checked
  // available_gb without deducting anything, so a burst of creations could
  // each pass the check before the next one landed — see migration 0007 for
  // the full rationale. reserve_credential_bandwidth() does the check and
  // the commit (via allocated_gb) as a single locked statement, so there's
  // no window between "checked" and "reserved" for a concurrent request to
  // slip through.
  const { error: reserveErr } = await supabase.rpc('reserve_credential_bandwidth', {
    p_user_id: user.id,
    p_gb: gb_allocated,
  })
  if (reserveErr) {
    return NextResponse.json({
      error: reserveErr.message?.includes('Insufficient')
        ? `Insufficient bandwidth. Requested ${gb_allocated}GB is more than you have available.`
        : reserveErr.message,
    }, { status: 402 })
  }

  // 2. Attempt Geonode — only when provider is configured. A failure here
  // doesn't give up the reservation — it just means the credential comes
  // back as 'pending' rather than 'active', same as the v1 API path, and
  // gets a real Geonode sub-user provisioned the next time this account's
  // bandwidth is activated (see lib/bandwidth.ts).
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
      console.error('Geonode createSubUser error — leaving credential as pending:', e)
    }
  }

  // 3. Insert credential row
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
      asn: asn ?? null,
      status,
      activated_at: status === 'active' ? new Date().toISOString() : null,
    })
    .select('id, status')
    .single()

  if (insertErr) {
    // Clean up the real Geonode sub-user we just created — otherwise it's
    // orphaned on Geonode's side with no local record and no way to find it.
    if (gcred) {
      await deleteSubUser(gcred.geonode_sub_user_id).catch((e) =>
        console.error('Failed to clean up orphaned Geonode sub-user', gcred?.geonode_sub_user_id, e)
      )
    }
    // Give back the reservation — nothing was actually persisted.
    const { error: releaseErr } = await supabase.rpc('release_credential_bandwidth', { p_user_id: user.id, p_gb: gb_allocated })
    if (releaseErr) console.error('Failed to release bandwidth reservation after insert failure:', releaseErr)
    return NextResponse.json({ error: insertErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, id: cred.id, status: cred.status })
}
