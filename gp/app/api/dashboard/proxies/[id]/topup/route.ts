import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { updateSubUserTrafficLimit } from '@/lib/geonode'
import { NextResponse } from 'next/server'

// Adds GB to a credential the user already owns, instead of requiring a
// brand-new credential every time they run out. Deliberately additive —
// "create a new one" (dashboard/proxies POST) stays available and
// unchanged; some customers want a disposable, capped credential (e.g.
// handing one to a client or a tool they don't fully trust) and shouldn't
// have that silently made extendable. Top-up is an explicit action on an
// existing credential, never the default.
export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended

  const { id } = await context.params
  const body = await req.json().catch(() => ({}))
  const gb_amount = Number(body?.gb_amount)

  if (!gb_amount || gb_amount <= 0) {
    return NextResponse.json({ error: 'gb_amount must be greater than 0' }, { status: 400 })
  }

  // Atomic reserve-against-balance + bump-this-credential's-gb_allocated,
  // in one transaction — see migration 0016 for the full rationale (same
  // "don't let a reservation and its corresponding write drift apart on a
  // partial failure" lesson as migration 0015's claim_and_credit_order).
  // topup_credential is service_role-only (not granted to `authenticated`
  // — see migration 0016/0012), so this goes through the admin client;
  // the user's own identity was already verified above via their session,
  // same pattern as every other service_role-only RPC call in this app.
  const admin = await createAdminClient()
  const { data: rawNewTotal, error: topupErr } = await admin.rpc('topup_credential', {
    p_credential_id: id,
    p_user_id: user.id,
    p_gb: gb_amount,
  })

  if (topupErr) {
    const msg = topupErr.message ?? 'Top-up failed'
    const status =
      msg.includes('Insufficient') ? 402 :
      topupErr.code === 'P0002' || msg.includes('not found') ? 404 :
      msg.includes('reseller') ? 403 :
      400
    return NextResponse.json({ error: msg }, { status })
  }

  // Postgres `numeric` can come back from PostgREST as a string — coerce
  // explicitly rather than trusting the JS type. This value is only used
  // to tell Geonode the new cap and to report back to the client; the
  // actual source of truth already committed atomically above regardless
  // of how this parses.
  const newTotal = Number(rawNewTotal)

  // Only 'active' credentials with a real Geonode sub-user need a live
  // PATCH — 'pending' ones (provider was down at creation time) pick up
  // the higher gb_allocated automatically next time activateBandwidth()
  // provisions them.
  const { data: cred } = await admin
    .from('proxy_credentials')
    .select('status, geonode_sub_user_id')
    .eq('id', id)
    .single()

  if (cred?.status === 'active' && cred.geonode_sub_user_id && Number.isFinite(newTotal)) {
    try {
      // MB, not GB — matches createSubUser's trafficLimitMB convention.
      // NEVER pass activeUntil alongside this: per Geonode's own spec,
      // changing activeUntil resets trafficUsedMB to zero. Keeping this
      // call to trafficLimitMB only is deliberate, not an oversight — see
      // updateSubUserTrafficLimit's own comment in lib/geonode.ts.
      await updateSubUserTrafficLimit(cred.geonode_sub_user_id, newTotal * 1024)
    } catch (e) {
      // The reservation and gb_allocated bump already committed atomically
      // above — that's the real source of truth and it's correct as-is.
      // A failure here only means Geonode's own cap hasn't caught up to
      // it yet. Safe direction for the customer (nothing becomes
      // over-permissive; if anything Geonode's live cap is temporarily
      // BELOW what they've now paid for, not above it) — but it does need
      // human eyes rather than being silently swallowed, since there's no
      // automatic retry for this specific step yet.
      console.error('[topup] DB committed but Geonode PATCH failed — needs manual reconciliation', id, e)
      return NextResponse.json({
        success: true,
        gb_allocated: newTotal,
        warning: 'Your balance was reserved and this credential\u2019s allocation was increased, but updating the live proxy limit failed. If it doesn\u2019t resolve shortly, contact support.',
      })
    }
  }

  return NextResponse.json({ success: true, gb_allocated: newTotal })
}
