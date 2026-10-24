import type { createAdminClient } from '@/lib/supabase/server'
import { alertAdminPayment } from '@/lib/paymentAlerts'
import { dispatchWebhook } from '@/lib/webhooks'
import { placePaymentHold } from '@/lib/paymentHold'
import { sendDisputeLostEmail } from '@/lib/billingEmails'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

export interface DisputedOrder {
  id: string
  user_id: string
  amount_usd: number | string
  refunded_usd?: number | string | null
  is_canary?: boolean | null
}

export interface DisputeLossResult {
  applied: boolean
  reason?: string
  refundUsd: number
  gbClawed: number
  gbNotRecoverable: number
  creditNote: string | null
}

// A chargeback the merchant lost (or accepted, or let Paystack auto-accept after
// the response window): Paystack takes the money back from our balance, but —
// unlike a refund started by us — sends no refund.processed event for it. Without
// this the customer kept every GB they had paid for. This reuses the refund
// ledger so the same things happen as for any refund: the proportional bandwidth
// that is not already allocated to a session is taken back, a credit note is
// issued, the referral / affiliate triggers reduce what was earned on the order,
// and the order flips to 'refunded' once nothing is left.
//
// Idempotent per order (the ledger reference is dispute_<order id>): the Paystack
// webhook can redeliver and an admin can press the button twice. `amountUsd`
// limits the clawback to part of the order (default: everything not yet refunded).
export async function applyDisputeLoss(
  supabase: Admin,
  order: DisputedOrder,
  opts: { source: string; amountUsd?: number; resolution?: string | null },
): Promise<DisputeLossResult> {
  const remaining = Math.max(Math.round((Number(order.amount_usd) - Number(order.refunded_usd ?? 0)) * 100) / 100, 0)
  const wanted = opts.amountUsd != null ? Math.min(Math.round(opts.amountUsd * 100) / 100, remaining) : remaining

  let result: any = { applied: false, reason: 'nothing_to_refund' }
  if (wanted > 0) {
    const { data, error } = await supabase.rpc('apply_order_refund', {
      p_order_id: order.id,
      p_refund_reference: `dispute_${order.id}`,
      p_refund_usd: wanted,
      p_source: 'dispute',
    })
    if (error) throw error // transient — the caller answers 500 / the admin retries
    result = data ?? result
  }

  // The dispute is now decided against us whether or not any GB could be taken
  // back (an order that was already fully refunded has nothing left to claw).
  const { error: stErr } = await supabase.from('orders').update({
    dispute_status: 'lost',
    ...(opts.resolution ? { dispute_resolution: String(opts.resolution).slice(0, 200) } : {}),
  }).eq('id', order.id)
  if (stErr) throw stErr

  const out: DisputeLossResult = {
    applied: !!result?.applied,
    reason: result?.reason,
    refundUsd: Number(result?.refund_usd ?? 0),
    gbClawed: Number(result?.gb_clawed ?? 0),
    gbNotRecoverable: Number(result?.gb_shortfall ?? 0),
    creditNote: result?.credit_note ?? null,
  }

  // A lost chargeback puts the account on hold (cleared by an admin). Applies whether or
  // not any GB could be taken back; a failed write is logged and never undoes the loss.
  if (!order.is_canary) {
    const placed = await placePaymentHold(supabase, order.user_id, {
      reason: `Payment dispute lost (${opts.source})`, source: 'dispute_lost', orderId: order.id,
    })
    if (placed) {
      await alertAdminPayment('Account put on payment hold after a lost dispute', {
        order_id: order.id, user_id: order.user_id,
        note: 'New purchases are blocked for this account until you clear the hold (Admin → user → Payment hold).',
      })
    }
  }

  if (out.applied) {
    await alertAdminPayment('DISPUTE LOST — bandwidth taken back', {
      order_id: order.id, source: opts.source, refund_usd: out.refundUsd, credit_note: out.creditNote,
      gb_clawed_back: out.gbClawed, gb_not_recoverable: out.gbNotRecoverable,
      note: out.gbNotRecoverable > 0
        ? 'Some of the GB was already allocated to sessions and could not be taken back. Consider suspending or restricting the account.'
        : 'All of the disputed bandwidth was recovered.',
    })
    if (!order.is_canary) {
      await dispatchWebhook(order.user_id, 'bandwidth_refunded', {
        order_id: order.id, refund_usd: out.refundUsd, gb_clawed_back: out.gbClawed,
        gb_not_recoverable: out.gbNotRecoverable, fully_refunded: remaining - out.refundUsd <= 0.005,
      })
      await sendDisputeLostEmail(supabase, order.user_id, {
        refundUsd: out.refundUsd, gbClawed: out.gbClawed, gbNotRecoverable: out.gbNotRecoverable, creditNote: out.creditNote,
      })
    }
  } else if (out.reason && out.reason !== 'duplicate' && out.reason !== 'nothing_to_refund') {
    await alertAdminPayment('Dispute lost but the bandwidth could not be taken back automatically', {
      order_id: order.id, source: opts.source, reason: out.reason,
    })
  }
  return out
}
