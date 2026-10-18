import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { createSubUser, deleteSubUser } from '@/lib/geonode'
import { validateTargeting } from '@/lib/proxyEndpoint'
import { dispatchWebhook } from '@/lib/webhooks'
import { NextResponse } from 'next/server'
import { requireMfaVerified } from '@/lib/mfa'

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

  // 2FA step-up: an account that enabled two-factor must hold a verified
  // session for this action — a password alone isn't enough. See lib/mfa.ts.
  const mfaGate = await requireMfaVerified(req, user.id)
  if (mfaGate) return mfaGate


  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended

  const body = await req.json()
  const {
    label, gb_allocated, country, state, city, asn,
    protocol = 'http', session_type = 'rotating',
    sticky_duration, endpoint_count = 1,
    auto_topup_enabled = false, auto_topup_threshold_gb, auto_topup_amount_gb,
  } = body

  if (!gb_allocated || gb_allocated <= 0) {
    return NextResponse.json({ error: 'gb_allocated must be greater than 0' }, { status: 400 })
  }

  const targetingError = validateTargeting({ country, state, city, asn })
  if (targetingError) {
    return NextResponse.json({ error: targetingError }, { status: 400 })
  }

  // Validated up front, before reserving bandwidth or touching Geonode —
  // same checks set_auto_topup() (migration 0017) makes at the DB layer,
  // duplicated here only so a bad auto-allocate config fails fast with no
  // side effects yet, rather than after a real reservation/Geonode
  // sub-user already exist and would need to be unwound over a config
  // typo.
  if (auto_topup_enabled) {
    if (!Number.isFinite(Number(auto_topup_threshold_gb)) || Number(auto_topup_threshold_gb) < 0) {
      return NextResponse.json({ error: 'auto_topup_threshold_gb must be a number ≥ 0' }, { status: 400 })
    }
    if (!Number.isFinite(Number(auto_topup_amount_gb)) || Number(auto_topup_amount_gb) <= 0) {
      return NextResponse.json({ error: 'auto_topup_amount_gb must be a number greater than 0' }, { status: 400 })
    }
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

  // 4. Enable auto-allocate, if requested. A separate call rather than
  // columns on the insert above because set_auto_topup() (migration 0017)
  // is the one place that owns "is this config valid for this credential"
  // — every other write path to auto-allocate settings (the dashboard
  // toggle on an existing session) goes through it too, so this doesn't
  // duplicate that logic, just calls it once more right after creation.
  // Non-fatal: the session itself was already created successfully above:
  // if this fails, the customer still has a working session, just without
  // auto-allocate on yet — they can turn it on from the Bandwidth tab.
  // The pre-validation above means this should only ever fail here on a
  // genuine race (e.g. status flipped between insert and this call).
  let autoTopupWarning: string | undefined
  if (auto_topup_enabled) {
    const admin = await createAdminClient()
    const { error: autoErr } = await admin.rpc('set_auto_topup', {
      p_credential_id: cred.id,
      p_user_id: user.id,
      p_enabled: true,
      p_threshold_gb: Number(auto_topup_threshold_gb),
      p_amount_gb: Number(auto_topup_amount_gb),
    })
    if (autoErr) {
      console.error('Failed to enable auto-allocate on new credential', cred.id, autoErr)
      autoTopupWarning = 'Session created, but auto-allocate couldn\u2019t be turned on — enable it from the Bandwidth tab.'
    }
  }

  // Notify — non-fatal, same reasoning as the auto-allocate follow-up
  // above: the session is already created and successful at this point,
  // a webhook delivery problem on the customer's end must never surface
  // as this request having failed.
  await dispatchWebhook(user.id, 'session_created', {
    credential_id: cred.id,
    label: label || null,
    protocol,
    session_type,
    gb_allocated,
    country: country ?? null,
    state: state ?? null,
    city: city ?? null,
    asn: asn ?? null,
    status: cred.status,
  }).catch((e) => console.error('[webhooks] session_created dispatch threw', cred.id, e))

  return NextResponse.json({ success: true, id: cred.id, status: cred.status, warning: autoTopupWarning })
}
