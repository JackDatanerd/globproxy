import { createAdminClient } from '@/lib/supabase/server'
import { initializeTransaction, generateReference } from '@/lib/paystack'
import { appUrl } from '@/lib/appUrl'
import type { OrderQuote } from '@/lib/plans'

// The one place a hosted-checkout order is created. /api/checkout (the dashboard buy
// page) and POST /api/v1/orders (API keys) both end here, so what is charged, what the
// order row holds and how a failed start is cleaned up can never drift apart.
type Admin = Awaited<ReturnType<typeof createAdminClient>>

// A payment dispute (chargeback) open on the account pauses new purchases —
// otherwise buy → use → dispute can be repeated. Secondary control: if the lookup
// itself fails it is logged and the purchase proceeds rather than turning a DB
// hiccup into a checkout outage.
export async function hasOpenDispute(supabase: Admin, userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('orders').select('id').eq('user_id', userId).eq('dispute_status', 'open').limit(1)
  if (error) console.error('[checkout] dispute lookup failed', error)
  return !!data && data.length > 0
}

export const DISPUTE_PAUSE_MESSAGE =
  'New purchases are paused while a payment dispute on your account is open. Please contact support@globproxy.com.'

export type CheckoutStart = {
  order: { id: string; created_at: string }
  url: string
  access_code: string
  reference: string
}

// Creates the pending order and initialises it with Paystack. Older pending orders are
// only retired AFTER that succeeds — cancelling them up front left a failed initialise
// with no live order at all. Throws on failure (callers answer a generic 500).
export async function startCheckout(
  supabase: Admin,
  user: { id: string; email: string },
  quote: OrderQuote,
  kes: { amount: number; rate: number } | null = null,
): Promise<CheckoutStart> {
  const reference = generateReference()

  const { data: order, error } = await supabase.from('orders').insert({
    user_id: user.id,
    gb_amount: quote.gb,
    amount_usd: quote.total,
    plan_slug: quote.slug, // which plan (or 'custom') — printed on the invoice
    payment_method: kes ? 'mpesa' : 'paystack',
    payment_status: 'pending',
    paystack_reference: reference,
    // M-Pesa: the KES amount the customer is asked to pay, locked now, plus the rate it
    // came from. Verification expects exactly this, not the USD price.
    ...(kes ? { pay_currency: 'KES', pay_amount: kes.amount, fx_rate: kes.rate } : {}),
  }).select().single()
  if (error || !order) throw error ?? new Error('order insert returned no row')

  let txn
  try {
    txn = await initializeTransaction({
      email: user.email,
      amount_usd: quote.total,
      ...(kes ? { currency: 'KES' as const, amount_major: kes.amount, channels: ['mobile_money'] } : {}),
      reference,
      metadata: {
        order_id: order.id,
        user_id: user.id,
        gb_amount: String(quote.gb),
        plan: quote.slug,
        ...(kes ? { currency: 'KES', amount_kes: String(kes.amount) } : {}),
      },
      callback_url: `${appUrl()}/dashboard?payment=success&reference=${reference}`,
    })
  } catch (initErr) {
    // The reference never reached Paystack, so nothing can ever be paid against this
    // order — drop it instead of leaving an orphan 'pending'.
    const { error: delErr } = await supabase.from('orders').delete().eq('id', order.id)
    if (delErr) {
      await supabase.from('orders').update({
        payment_status: 'cancelled', failure_reason: 'checkout initialization failed', failed_at: new Date().toISOString(),
      }).eq('id', order.id)
    }
    throw initErr
  }

  // Retire the customer's other pending orders so the history doesn't pile up with
  // abandoned checkouts. Safe even if one is still being paid elsewhere: the webhook /
  // verify-payment / reconcile cron credit any order Paystack confirms as paid,
  // whatever its local status.
  await supabase
    .from('orders')
    .update({ payment_status: 'cancelled' })
    .eq('user_id', user.id)
    .eq('payment_status', 'pending')
    .neq('id', order.id)

  return { order: { id: order.id, created_at: order.created_at }, url: txn.authorization_url, access_code: txn.access_code, reference }
}
