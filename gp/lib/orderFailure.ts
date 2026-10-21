import type { createAdminClient } from '@/lib/supabase/server'
import { sendPaymentFailedEmail } from '@/lib/billingEmails'
import { alertAdminPayment } from '@/lib/paymentAlerts'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

export interface FailableOrder {
  id: string
  user_id: string
  amount_usd: number | string
  gb_amount: number | string
  is_canary?: boolean | null
  pay_currency?: string | null
  pay_amount?: number | string | null
  paystack_reference?: string | null
}

// The ONE place an order goes pending → failed because Paystack says the charge
// did not go through. Used by every path that can learn of a decline — the
// webhook, /api/verify-payment, the reconcile cron and the canary — so they
// cannot drift.
//
// Paystack documents no `charge.failed` webhook event, so a decline is normally
// discovered by asking Paystack (verify / reconcile), not by being told. The
// transition is conditional on the order still being 'pending' and runs once:
// the customer email and the admin alert go out only for the call that actually
// flipped the row. 'failed' is purely informational — a later successful charge
// on the same checkout is still credited (claim_and_credit_order accepts it).
//
// Returns true when THIS call made the transition.
export async function failPendingOrder(
  supabase: Admin,
  order: FailableOrder,
  reason: string | null,
  opts: { source: string; alertAdmin?: boolean },
): Promise<boolean> {
  const { data: flipped, error } = await supabase.from('orders').update({
    payment_status: 'failed',
    failure_reason: (reason ?? 'Declined').slice(0, 300),
    failed_at: new Date().toISOString(),
  }).eq('id', order.id).eq('payment_status', 'pending').eq('bandwidth_credited', false).select('id')
  if (error) throw error
  if ((flipped?.length ?? 0) === 0) return false

  if (order.is_canary) {
    // The synthetic canary charge is never a customer event — but a canary that
    // fails means real customers' payments may be failing too.
    await alertAdminPayment('CANARY payment failed — the daily end-to-end payment test did not succeed', {
      order_id: order.id, reference: order.paystack_reference ?? '', reason: reason ?? 'Declined', source: opts.source,
    })
    return true
  }

  const mpesa = order.pay_currency && String(order.pay_currency).toUpperCase() !== 'USD' && order.pay_amount != null
    ? { currency: String(order.pay_currency).toUpperCase(), amount: Number(order.pay_amount) }
    : null
  await sendPaymentFailedEmail(supabase, order.user_id, {
    amountUsd: Number(order.amount_usd), gb: Number(order.gb_amount), reason: reason ?? null, mpesa,
  })
  if (opts.alertAdmin) {
    await alertAdminPayment('Payment failed', {
      order_id: order.id, reference: order.paystack_reference ?? '', reason: reason ?? 'Declined',
      amount_usd: Number(order.amount_usd), gb: Number(order.gb_amount), method: mpesa ? 'M-Pesa' : 'card', source: opts.source,
    })
  }
  return true
}
