import { createAdminClient } from '@/lib/supabase/server'
import { chargeAuthorization, generateReference, verifyTransaction, paymentMismatchReason } from '@/lib/paystack'
import { activateBandwidth } from '@/lib/bandwidth'
import { resolveOrder } from '@/lib/plans'
import { purchaseBlock } from '@/lib/checkout'
import { currentTax } from '@/lib/invoiceTax'
import { sendAutoRechargeProblemEmail } from '@/lib/billingEmails'
import { alertAdminPayment } from '@/lib/paymentAlerts'
import { isBelowThreshold, withinCap, cooldownElapsed, RECHARGE_COOLDOWN_MS, RECHARGE_MAX_FAILURES } from '@/lib/rechargeRules'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

// Customer auto-recharge: a customer who opted in (Billing → Auto-recharge) has a reusable
// Paystack card authorization saved at a checkout where they ticked "save this card", and
// a rule — "when my unassigned balance drops below N GB, buy this plan, at most $X per 30
// days". The 'recharge' cron task (every 5 minutes) applies the rules. Everything after the
// charge is the normal payment path: the same order row, activateBandwidth(), invoice,
// confirmation e-mail and reconcile safety net as a checkout the customer paid by hand.

const MAX_RECHARGES_PER_RUN = 5 // a charge + verify + credit is several subrequests; the rest wait for the next tick
const CHUNK = 100

// Stores the reusable card behind a successful charge, when the customer agreed at checkout
// (metadata.save_card — set only by our own /api/checkout, and signed by Paystack). Best-effort:
// the credit is already committed, so nothing here may fail the webhook.
export async function captureSavedCard(supabase: Admin, userId: string, data: any): Promise<boolean> {
  try {
    const auth = data?.authorization
    if (!auth?.reusable || !auth?.authorization_code) return false
    if (auth.channel && String(auth.channel) !== 'card') return false
    const email = String(data?.customer?.email ?? '').trim()
    if (!email) return false
    const { error } = await supabase.from('saved_cards').upsert({
      user_id: userId,
      authorization_code: String(auth.authorization_code),
      email,
      brand: String(auth.card_type ?? auth.brand ?? '').trim().slice(0, 30) || null,
      last4: String(auth.last4 ?? '').slice(0, 4) || null,
      exp_month: String(auth.exp_month ?? '').slice(0, 2) || null,
      exp_year: String(auth.exp_year ?? '').slice(0, 4) || null,
      signature: auth.signature ? String(auth.signature) : null,
      consent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })
    if (error) { console.error('[auto-recharge] could not save the card', userId, error); return false }
    return true
  } catch (e) {
    console.error('[auto-recharge] card capture threw', userId, e)
    return false
  }
}

export async function runAutoRecharge(): Promise<Record<string, unknown>> {
  try {
    const supabase = await createAdminClient()
    const { data: rules, error } = await supabase.from('auto_recharge').select('*')
      .eq('enabled', true).order('last_attempt_at', { ascending: true, nullsFirst: true }).limit(500)
    if (error) return { error: `auto-recharge rules could not be read: ${error.message}` }
    if (!rules?.length) return { enabled: 0 }

    // One balance read per chunk, not one per customer.
    const balance = new Map<string, number>()
    for (let i = 0; i < rules.length; i += CHUNK) {
      const ids = rules.slice(i, i + CHUNK).map(r => r.user_id)
      const { data, error: bErr } = await supabase.from('bandwidth_accounts').select('user_id, available_gb').in('user_id', ids)
      if (bErr) return { error: `bandwidth balances could not be read: ${bErr.message}` }
      for (const b of data ?? []) balance.set(b.user_id, Number(b.available_gb))
    }

    let attempted = 0, recharged = 0, pending = 0, failed = 0, skipped = 0
    const errors: string[] = []
    for (const r of rules) {
      if (attempted >= MAX_RECHARGES_PER_RUN) break
      // No balance row = nothing bought yet; auto-recharge tops up, it does not first-buy.
      if (!balance.has(r.user_id) || !isBelowThreshold(balance.get(r.user_id)!, Number(r.threshold_gb))) continue
      if (!cooldownElapsed(r.last_attempt_at)) continue
      try {
        const out = await rechargeOne(supabase, r)
        if (out === 'skipped') { skipped++; continue }
        attempted++
        if (out === 'credited') recharged++
        else if (out === 'pending') pending++
        else failed++
      } catch (e: any) {
        attempted++; failed++
        errors.push(`${r.user_id}: ${e?.message ?? e}`)
        console.error('[auto-recharge] attempt threw', r.user_id, e)
      }
    }
    return { enabled: rules.length, attempted, recharged, pending, failed, skipped, ...(errors.length ? { error: `${errors.length} auto-recharge attempt(s) threw: ${errors[0]}` } : {}) }
  } catch (e: any) {
    console.error('[auto-recharge] run failed', e)
    return { error: e?.message ?? 'auto-recharge run failed' }
  }
}

async function disable(supabase: Admin, userId: string, reason: string) {
  const { error } = await supabase.from('auto_recharge')
    .update({ enabled: false, disabled_reason: reason.slice(0, 200), updated_at: new Date().toISOString() }).eq('user_id', userId)
  if (error) console.error('[auto-recharge] could not switch off', userId, error)
}

type Outcome = 'skipped' | 'credited' | 'pending' | 'failed'

async function rechargeOne(supabase: Admin, r: any): Promise<Outcome> {
  const userId: string = r.user_id

  const { data: profile, error: pErr } = await supabase.from('profiles').select('is_deleted, is_suspended').eq('id', userId).maybeSingle()
  if (pErr) throw pErr
  if (!profile || profile.is_deleted) { await disable(supabase, userId, 'account_closed'); return 'skipped' }
  if (profile.is_suspended) return 'skipped' // comes back by itself if the account does
  if (await purchaseBlock(supabase, userId)) return 'skipped' // open dispute / payment hold

  const { data: card, error: cErr } = await supabase.from('saved_cards').select('authorization_code, email').eq('user_id', userId).maybeSingle()
  if (cErr) throw cErr
  if (!card) { await disable(supabase, userId, 'no_saved_card'); return 'skipped' }

  const quote = resolveOrder(r.plan_slug, r.gb ?? undefined)
  if (!quote) { await disable(supabase, userId, 'invalid_plan'); return 'skipped' }

  // The customer's own ceiling, over a rolling 30 days (pending counts: it may yet be paid).
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const { data: past, error: sErr } = await supabase.from('orders').select('amount_usd')
    .eq('user_id', userId).eq('auto_recharge', true).in('payment_status', ['pending', 'paid']).gte('created_at', since)
  if (sErr) throw sErr
  const spent = (past ?? []).reduce((s, o) => s + Number(o.amount_usd), 0)
  if (!withinCap(spent, quote.total, Number(r.monthly_cap_usd))) {
    // Tell them once per cap period, then stay quiet until they raise it.
    const { data: told } = await supabase.from('auto_recharge').update({ cap_notified_at: new Date().toISOString() })
      .eq('user_id', userId).or(`cap_notified_at.is.null,cap_notified_at.lt.${since}`).select('user_id')
    if ((told?.length ?? 0) > 0) {
      await sendAutoRechargeProblemEmail(supabase, userId, { kind: 'cap', amountUsd: quote.total, gb: quote.gb, capUsd: Number(r.monthly_cap_usd) })
    }
    return 'skipped'
  }

  // Claim the attempt: two overlapping ticks cannot both charge the card.
  const cutoff = new Date(Date.now() - RECHARGE_COOLDOWN_MS).toISOString()
  const { data: claimed, error: clErr } = await supabase.from('auto_recharge')
    .update({ last_attempt_at: new Date().toISOString() })
    .eq('user_id', userId).eq('enabled', true).or(`last_attempt_at.is.null,last_attempt_at.lte.${cutoff}`).select('user_id')
  if (clErr) throw clErr
  if (!claimed?.length) return 'skipped'

  const reference = generateReference()
  const tax = currentTax()
  const { data: order, error: oErr } = await supabase.from('orders').insert({
    user_id: userId, gb_amount: quote.gb, amount_usd: quote.total, plan_slug: quote.slug,
    payment_method: 'paystack', payment_status: 'pending', paystack_reference: reference, auto_recharge: true,
    ...(tax ? { tax_rate_pct: tax.rate, tax_label: tax.label } : {}),
  }).select('id').single()
  if (oErr || !order) throw oErr ?? new Error('order insert returned no row')
  await supabase.from('auto_recharge').update({ last_order_id: order.id }).eq('user_id', userId)

  let status = ''
  let gateway: string | null = null
  try {
    const res = await chargeAuthorization({
      email: card.email, amount_usd: quote.total, reference, authorization_code: card.authorization_code,
      metadata: { order_id: order.id, user_id: userId, gb_amount: String(quote.gb), plan: quote.slug, auto_recharge: '1' },
    })
    status = String(res.status ?? '')
    gateway = res.gateway_response ?? null
  } catch (e: any) {
    status = 'failed'
    gateway = e?.message ?? 'charge failed'
  }

  if (status === 'success') {
    try {
      const txn = await verifyTransaction(reference)
      if (txn.status === 'success' && !paymentMismatchReason(txn, { amount_usd: quote.total, paystack_reference: reference })) {
        const result = await activateBandwidth({
          order_id: order.id, user_id: userId, gb_amount: quote.gb, paystack_reference: reference, amount_usd: quote.total, is_canary: false,
        })
        if (result.status !== 'error') {
          await supabase.from('auto_recharge').update({ consecutive_failures: 0, disabled_reason: null, updated_at: new Date().toISOString() }).eq('user_id', userId)
          return 'credited'
        }
      }
    } catch (e) {
      console.error('[auto-recharge] could not confirm a successful charge — reconcile will', order.id, e)
    }
    return 'pending' // money moved; the webhook / reconcile cron completes the credit
  }

  if (status === 'failed' || status === 'abandoned' || status === 'reversed') {
    await supabase.from('orders').update({
      payment_status: 'failed', failure_reason: (gateway ?? 'Declined').slice(0, 300), failed_at: new Date().toISOString(),
    }).eq('id', order.id).eq('payment_status', 'pending').eq('bandwidth_credited', false)

    const failures = Number(r.consecutive_failures ?? 0) + 1
    const off = failures >= RECHARGE_MAX_FAILURES
    await supabase.from('auto_recharge').update({
      consecutive_failures: failures, updated_at: new Date().toISOString(),
      ...(off ? { enabled: false, disabled_reason: `payment_failed: ${(gateway ?? 'declined').slice(0, 120)}` } : {}),
    }).eq('user_id', userId)
    await sendAutoRechargeProblemEmail(supabase, userId, {
      kind: off ? 'disabled' : 'failed', amountUsd: quote.total, gb: quote.gb, reason: gateway,
    })
    if (off) await alertAdminPayment('Auto-recharge switched off after repeated failures', { user_id: userId, reason: gateway ?? '' })
    return 'failed'
  }

  // Anything else (a card that wants 3-D Secure / an OTP, still processing): the order stays
  // pending and the reconcile cron settles it; a card that needs the customer present will
  // simply never complete, and the customer is e-mailed by reconcile's failed-payment path.
  return 'pending'
}
