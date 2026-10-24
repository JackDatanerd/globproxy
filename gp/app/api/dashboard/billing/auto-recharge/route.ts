import { requireMfaVerified } from '@/lib/mfa'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { isCrossSiteRequest } from '@/lib/appUrl'
import { rateLimitedUser } from '@/lib/rateLimit'
import { resolveOrder } from '@/lib/plans'
import { validThreshold, validCap, RECHARGE_DEFAULT_CAP_USD } from '@/lib/rechargeRules'
import { NextResponse } from 'next/server'

// Auto-recharge settings (Billing → Auto-recharge). The saved card itself is never sent to
// the browser — only its brand, last four digits and expiry. Turning it on is a money-moving
// consent, so it needs the same step-up as buying; the card is saved at a checkout where the
// customer ticked "save this card" (lib/autoRecharge.ts captureSavedCard).
//
//   GET     → { card, settings }
//   PUT     { enabled, threshold_gb, plan, gb?, monthly_cap_usd }
//   DELETE  → removes the saved card and switches auto-recharge off

async function currentUser() {
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  return user
}

export async function GET(req: Request) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock
  const admin = await createAdminClient()
  const [{ data: card, error: cErr }, { data: rule, error: rErr }] = await Promise.all([
    admin.from('saved_cards').select('brand, last4, exp_month, exp_year').eq('user_id', user.id).maybeSingle(),
    admin.from('auto_recharge').select('enabled, threshold_gb, plan_slug, gb, monthly_cap_usd, consecutive_failures, disabled_reason').eq('user_id', user.id).maybeSingle(),
  ])
  if (cErr || rErr) {
    console.error('[auto-recharge] load failed', cErr ?? rErr)
    return NextResponse.json({ error: 'Could not load your auto-recharge settings.' }, { status: 500 })
  }
  return NextResponse.json({
    card: card ?? null,
    settings: rule ?? { enabled: false, threshold_gb: 5, plan_slug: 'starter', gb: null, monthly_cap_usd: RECHARGE_DEFAULT_CAP_USD, consecutive_failures: 0, disabled_reason: null },
  })
}

export async function PUT(req: Request) {
  if (isCrossSiteRequest(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock
  const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'auto-recharge')
  if (throttled) return throttled
  const inactive = await requireActiveUser(user.id)
  if (inactive) return inactive

  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request' }, { status: 400 }) }
  const enabled = body?.enabled === true
  if (!validThreshold(body?.threshold_gb)) return NextResponse.json({ error: 'Choose a threshold between 1 and 500 GB.' }, { status: 400 })
  if (!validCap(body?.monthly_cap_usd)) return NextResponse.json({ error: 'Choose a 30-day limit between $1 and $5,000.' }, { status: 400 })
  const quote = resolveOrder(body?.plan, body?.gb)
  if (!quote) return NextResponse.json({ error: 'Choose a plan or a whole number of GB to buy each time.' }, { status: 400 })
  if (quote.total > body.monthly_cap_usd) {
    return NextResponse.json({ error: `One top-up costs $${quote.total.toFixed(2)}, which is more than your $${body.monthly_cap_usd} 30-day limit. Raise the limit or pick a smaller top-up.` }, { status: 400 })
  }

  const admin = await createAdminClient()
  if (enabled) {
    const { data: card, error: cErr } = await admin.from('saved_cards').select('user_id').eq('user_id', user.id).maybeSingle()
    if (cErr) return NextResponse.json({ error: 'Could not check your saved card. Please try again.' }, { status: 500 })
    if (!card) return NextResponse.json({ error: 'Save a card first: tick "Save this card for auto-recharge" the next time you pay by card.' }, { status: 409 })
  }
  const { error } = await admin.from('auto_recharge').upsert({
    user_id: user.id, enabled, threshold_gb: body.threshold_gb, plan_slug: quote.slug,
    gb: quote.custom ? quote.gb : null, monthly_cap_usd: body.monthly_cap_usd,
    // Re-saving starts clean: a customer who fixed the problem is not penalised by old failures.
    consecutive_failures: 0, disabled_reason: null, cap_notified_at: null, updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' })
  if (error) {
    console.error('[auto-recharge] save failed', error)
    return NextResponse.json({ error: 'Could not save your auto-recharge settings. Please try again.' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: Request) {
  if (isCrossSiteRequest(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock
  const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'auto-recharge')
  if (throttled) return throttled

  const admin = await createAdminClient()
  // Switch the rule off FIRST: if the card delete then fails nothing can charge it.
  const { error: offErr } = await admin.from('auto_recharge')
    .update({ enabled: false, disabled_reason: 'card_removed', updated_at: new Date().toISOString() }).eq('user_id', user.id)
  if (offErr) {
    console.error('[auto-recharge] could not switch off', offErr)
    return NextResponse.json({ error: 'Could not remove your card. Please try again.' }, { status: 500 })
  }
  const { error } = await admin.from('saved_cards').delete().eq('user_id', user.id)
  if (error) {
    console.error('[auto-recharge] card delete failed', error)
    return NextResponse.json({ error: 'Could not remove your card. Please try again.' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
