import { createAdminClient } from '@/lib/supabase/server'
import { chargeAuthorization, generateReference, verifyTransaction, paymentMismatchReason, ChargeRejectedError } from '@/lib/paystack'
import { activateBandwidth } from '@/lib/bandwidth'
import { resolveOrder } from '@/lib/plans'
import { purchaseBlock } from '@/lib/checkout'
import { currentTax } from '@/lib/invoiceTax'
import { sendAutoRechargeProblemEmail } from '@/lib/billingEmails'
import { alertAdminPayment } from '@/lib/paymentAlerts'
import {
  withinCap, RECHARGE_COOLDOWN_MS, RECHARGE_MAX_FAILURES, needsCustomerAction, NEEDS_CUSTOMER_REASON,
  attemptStillOpen, orderSpend, cardExpired, cardExpiryLabel, CARD_WARN_DAYS,
} from '@/lib/rechargeRules'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

// Customer auto-recharge: a customer who opted in (Billing → Auto-recharge) has a reusable
// Paystack card authorization saved at a checkout where they ticked "save this card", and
// a rule — "when my unassigned balance drops below N GB, buy this plan, at most $X per 30
// days". The 'recharge' cron task (every 5 minutes) applies the rules. Everything after the
// charge is the normal payment path: the same order row, activateBandwidth(), invoice,
// confirmation e-mail and reconcile safety net as a checkout the customer paid by hand.

const MAX_RECHARGES_PER_RUN = 5 // a charge + verify + credit is several subrequests; the rest wait for the next tick
const DUE_BATCH = 100 // rules read per tick; the database has already filtered them to the ones that are due
const EXPIRY_BATCH = 50 // expiry notices sent per tick

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
    // A late webhook (redelivery, or a charge that settled after the customer deleted the
    // account) must not re-create a chargeable card for a closed account.
    const { data: prof, error: pErr } = await supabase.from('profiles').select('is_deleted').eq('id', userId).maybeSingle()
    if (pErr) { console.error('[auto-recharge] profile check failed', userId, pErr); return false }
    if (!prof || prof.is_deleted) return false
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
      expiry_warned_at: null, // a new card starts a new expiry warning cycle
    }, { onConflict: 'user_id' })
    if (error) { console.error('[auto-recharge] could not save the card', userId, error); return false }
    return true
  } catch (e) {
    console.error('[auto-recharge] card capture threw', userId, e)
    return false
  }
}

// What the rule has spent in the cap's rolling 30 days, and when it last paid. The cron
// (cap enforcement) and the Billing page (what the customer is shown) both call this, so
// they cannot disagree about how much headroom is left.
export async function autoRechargeSpend(supabase: Admin, userId: string): Promise<{ spent: number; lastChargeAt: string | null }> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const PAGE = 1000
  const rows: any[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('orders')
      .select('payment_status, amount_usd, refunded_usd, created_at')
      .eq('user_id', userId).eq('auto_recharge', true).in('payment_status', ['pending', 'paid']).gte('created_at', since)
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .range(from, from + PAGE - 1)
    if (error) throw error
    rows.push(...(data ?? []))
    if ((data?.length ?? 0) < PAGE) break
  }
  const lastPaid = rows.find(o => o.payment_status === 'paid')
  return { spent: orderSpend(rows), lastChargeAt: lastPaid?.created_at ?? null }
}

export async function runAutoRecharge(): Promise<Record<string, unknown>> {
  try {
    const supabase = await createAdminClient()

    // Tell customers whose saved card is about to lapse (or has) before it costs them a top-up.
    const expiry = await warnExpiringCards(supabase).catch((e) => {
      console.error('[auto-recharge] expiry sweep failed', e)
      return { warned: 0, expired: 0 }
    })

    // The database picks the rules that are due: enabled, below their threshold, past their
    // cooldown. (Reading "the 500 oldest attempts" and testing balances here let rules that
    // never need a top-up crowd out the ones that do, once there were enough of them.)
    const { data: due, error } = await supabase.rpc('auto_recharge_due', {
      p_cooldown_seconds: Math.round(RECHARGE_COOLDOWN_MS / 1000), p_limit: DUE_BATCH,
    })
    if (error) return { error: `auto-recharge rules could not be read: ${error.message}`, expiry }
    const rules = (due ?? []) as any[]
    if (!rules.length) return { due: 0, expiry }

    let attempted = 0, recharged = 0, pending = 0, failed = 0, skipped = 0
    const errors: string[] = []
    for (const r of rules) {
      if (attempted >= MAX_RECHARGES_PER_RUN) break
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
    return { due: rules.length, attempted, recharged, pending, failed, skipped, expiry, ...(errors.length ? { error: `${errors.length} auto-recharge attempt(s) threw: ${errors[0]}` } : {}) }
  } catch (e: any) {
    console.error('[auto-recharge] run failed', e)
    return { error: e?.message ?? 'auto-recharge run failed' }
  }
}

// One notice per card: "expires on MM/YYYY" ahead of time, or "has expired" (and the rule is
// switched off, since a lapsed card can only fail). A new card clears the mark.
async function warnExpiringCards(supabase: Admin): Promise<{ warned: number; expired: number }> {
  const { data, error } = await supabase.rpc('auto_recharge_expiring', { p_days: CARD_WARN_DAYS, p_limit: EXPIRY_BATCH })
  if (error) throw error
  let warned = 0, expired = 0
  for (const row of (data ?? []) as Array<{ user_id: string }>) {
    // Claim the notice first so two overlapping ticks cannot both send it.
    const { data: claimed, error: clErr } = await supabase.from('saved_cards')
      .update({ expiry_warned_at: new Date().toISOString() })
      .eq('user_id', row.user_id).is('expiry_warned_at', null).select('last4, exp_month, exp_year')
    if (clErr) { console.error('[auto-recharge] expiry claim failed', row.user_id, clErr); continue }
    const card = claimed?.[0]
    if (!card) continue
    const gone = cardExpired(card.exp_month, card.exp_year)
    if (gone) await disable(supabase, row.user_id, 'card_expired')
    await sendAutoRechargeProblemEmail(supabase, row.user_id, {
      kind: gone ? 'expired' : 'expiring', amountUsd: 0, gb: 0, last4: card.last4, expires: cardExpiryLabel(card.exp_month, card.exp_year),
    })
    if (gone) expired++; else warned++
  }
  return { warned, expired }
}

async function disable(supabase: Admin, userId: string, reason: string) {
  const { error } = await supabase.from('auto_recharge')
    .update({ enabled: false, disabled_reason: reason.slice(0, 200), updated_at: new Date().toISOString() }).eq('user_id', userId)
  if (error) console.error('[auto-recharge] could not switch off', userId, error)
}

type Outcome = 'skipped' | 'credited' | 'pending' | 'failed'

// Pushes a rule that is not going to be charged this tick to the back of the queue, so a
// few blocked accounts (open dispute, cap reached, an earlier attempt still settling) can
// never sit at the front and hold up the rules behind them. It is looked at again after
// the cooldown.
async function defer(supabase: Admin, userId: string) {
  const { error } = await supabase.from('auto_recharge').update({ last_attempt_at: new Date().toISOString() }).eq('user_id', userId)
  if (error) console.error('[auto-recharge] could not defer', userId, error)
}

async function rechargeOne(supabase: Admin, r: any): Promise<Outcome> {
  const userId: string = r.user_id

  const { data: profile, error: pErr } = await supabase.from('profiles').select('is_deleted, is_suspended').eq('id', userId).maybeSingle()
  if (pErr) throw pErr
  if (!profile || profile.is_deleted) { await disable(supabase, userId, 'account_closed'); return 'skipped' }
  if (profile.is_suspended) { await defer(supabase, userId); return 'skipped' } // comes back by itself if the account does
  if (await purchaseBlock(supabase, userId)) { await defer(supabase, userId); return 'skipped' } // open dispute / payment hold

  const { data: card, error: cErr } = await supabase.from('saved_cards').select('authorization_code, email, last4, exp_month, exp_year').eq('user_id', userId).maybeSingle()
  if (cErr) throw cErr
  if (!card) { await disable(supabase, userId, 'no_saved_card'); return 'skipped' }
  if (cardExpired(card.exp_month, card.exp_year)) {
    // A lapsed card can only fail; say so once instead of failing three times.
    await disable(supabase, userId, 'card_expired')
    await sendAutoRechargeProblemEmail(supabase, userId, { kind: 'expired', amountUsd: 0, gb: 0, last4: card.last4, expires: cardExpiryLabel(card.exp_month, card.exp_year) })
    return 'skipped'
  }

  const quote = resolveOrder(r.plan_slug, r.gb ?? undefined)
  if (!quote) { await disable(supabase, userId, 'invalid_plan'); return 'skipped' }

  // The previous top-up may still be settling (a slow charge, a webhook not landed, an
  // answer we never saw). The balance is low only because it has not been credited yet:
  // charging again would buy twice.
  if (r.last_order_id) {
    const { data: prev, error: prevErr } = await supabase.from('orders')
      .select('payment_status, bandwidth_credited, created_at').eq('id', r.last_order_id).maybeSingle()
    if (prevErr) throw prevErr
    if (attemptStillOpen(prev)) { await defer(supabase, userId); return 'skipped' }
  }

  // The customer's own ceiling, over a rolling 30 days (pending counts: it may yet be paid).
  const { spent } = await autoRechargeSpend(supabase, userId)
  if (!withinCap(spent, quote.total, Number(r.monthly_cap_usd))) {
    // Tell them once per cap period, then stay quiet until they raise it.
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const { data: told } = await supabase.from('auto_recharge').update({ cap_notified_at: new Date().toISOString() })
      .eq('user_id', userId).or(`cap_notified_at.is.null,cap_notified_at.lt.${since}`).select('user_id')
    if ((told?.length ?? 0) > 0) {
      await sendAutoRechargeProblemEmail(supabase, userId, { kind: 'cap', amountUsd: quote.total, gb: quote.gb, capUsd: Number(r.monthly_cap_usd) })
    }
    await defer(supabase, userId)
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
    if (e instanceof ChargeRejectedError) {
      // Paystack refused the request outright: nothing was charged.
      status = 'failed'
      gateway = e.message || 'charge failed'
    } else {
      // We do not know whether the card was charged (timeout, dropped connection, 5xx, an
      // unreadable answer). Not a decline: the order stays pending, no failure is counted
      // and the customer is not told "you have not been charged". The webhook, or the
      // reconcile cron looking the reference up, settles it; the open attempt blocks a
      // second charge in the meantime.
      console.error('[auto-recharge] charge outcome unknown — leaving the order pending for reconcile', order.id, e)
      return 'pending'
    }
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

  // A card that wants an OTP / 3-D Secure cannot be topped up with nobody there. It is a
  // failure now, not a pending order retried every cooldown.
  if (needsCustomerAction(status)) {
    status = 'failed'
    gateway = NEEDS_CUSTOMER_REASON
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

  // Anything else (still processing): the order stays pending and the reconcile cron
  // settles it; the open attempt stops the next tick charging a second time.
  return 'pending'
}
