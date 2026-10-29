import { createAdminClient } from '@/lib/supabase/server'
import { chargeAuthorization, generateReference, verifyTransaction, paymentMismatchReason, ChargeRejectedError } from '@/lib/paystack'
import { activateBandwidth } from '@/lib/bandwidth'
import { currentTax } from '@/lib/invoiceTax'
import { needsCustomerAction, cardExpired } from '@/lib/rechargeRules'
import type { OrderQuote } from '@/lib/plans'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

// One-click purchase on the card the customer saved at an earlier checkout (the same Paystack
// authorization auto-recharge uses — lib/autoRecharge.ts captureSavedCard). The customer is
// present and has just confirmed the amount, so this is the interactive twin of an auto-recharge
// charge: same order row, same verify-then-credit, same webhook / reconcile safety net.
//
//   credited     the card was charged and the bandwidth is in the account
//   pending      the outcome is not known yet (timeout, still processing) — the webhook or the
//                reconcile cron settles it; the caller polls the reference and must NOT charge again
//   declined     the bank refused; nothing was charged
//   needs_action the card wants an OTP / 3-D Secure, which only the normal checkout can do
//   no_card / card_expired   nothing saved, or the saved card has lapsed
export type SavedCardResult =
  | { outcome: 'credited'; reference: string }
  | { outcome: 'pending'; reference: string }
  | { outcome: 'declined'; reason: string }
  | { outcome: 'needs_action' }
  | { outcome: 'no_card' }
  | { outcome: 'card_expired' }

export async function payWithSavedCard(
  supabase: Admin, user: { id: string }, quote: OrderQuote,
): Promise<SavedCardResult> {
  const { data: card, error: cErr } = await supabase.from('saved_cards')
    .select('authorization_code, email, exp_month, exp_year').eq('user_id', user.id).maybeSingle()
  if (cErr) throw cErr
  if (!card) return { outcome: 'no_card' }
  if (cardExpired(card.exp_month, card.exp_year)) return { outcome: 'card_expired' }

  const reference = generateReference()
  const tax = currentTax() // frozen onto the order, like every other checkout
  const { data: order, error: oErr } = await supabase.from('orders').insert({
    user_id: user.id, gb_amount: quote.gb, amount_usd: quote.total, plan_slug: quote.slug,
    payment_method: 'paystack', payment_status: 'pending', paystack_reference: reference,
    ...(tax ? { tax_rate_pct: tax.rate, tax_label: tax.label } : {}),
  }).select('id').single()
  if (oErr || !order) throw oErr ?? new Error('order insert returned no row')

  let status = ''
  let gateway: string | null = null
  try {
    const res = await chargeAuthorization({
      email: card.email, amount_usd: quote.total, reference, authorization_code: card.authorization_code,
      metadata: { order_id: order.id, user_id: user.id, gb_amount: String(quote.gb), plan: quote.slug, saved_card: '1' },
    })
    status = String(res.status ?? '')
    gateway = res.gateway_response ?? null
  } catch (e: any) {
    if (e instanceof ChargeRejectedError) {
      status = 'failed'
      gateway = e.message || 'charge failed'
    } else {
      // Unknown whether the card was charged: leave the order pending for the webhook /
      // reconcile cron and tell the caller to poll — never to charge again.
      console.error('[saved-card] charge outcome unknown — leaving the order pending', order.id, e)
      return { outcome: 'pending', reference }
    }
  }

  if (status === 'success') {
    try {
      const txn = await verifyTransaction(reference)
      if (txn.status === 'success' && !paymentMismatchReason(txn, { amount_usd: quote.total, paystack_reference: reference })) {
        const result = await activateBandwidth({
          order_id: order.id, user_id: user.id, gb_amount: quote.gb, paystack_reference: reference, amount_usd: quote.total, is_canary: false,
        })
        if (result.status === 'credited' || result.status === 'already_credited') return { outcome: 'credited', reference }
      }
    } catch (e) {
      console.error('[saved-card] could not confirm a successful charge — reconcile will', order.id, e)
    }
    return { outcome: 'pending', reference } // money moved; the webhook / reconcile cron completes the credit
  }

  if (needsCustomerAction(status)) {
    await failOrder(supabase, order.id, 'Card needs extra verification')
    return { outcome: 'needs_action' }
  }
  if (status === 'failed' || status === 'abandoned' || status === 'reversed') {
    await failOrder(supabase, order.id, gateway ?? 'Declined')
    return { outcome: 'declined', reason: gateway ?? 'Your card was declined.' }
  }
  // Still processing: the order stays pending and the reconcile cron settles it.
  return { outcome: 'pending', reference }
}

async function failOrder(supabase: Admin, orderId: string, reason: string) {
  await supabase.from('orders').update({
    payment_status: 'failed', failure_reason: reason.slice(0, 300), failed_at: new Date().toISOString(),
  }).eq('id', orderId).eq('payment_status', 'pending').eq('bandwidth_credited', false)
}
