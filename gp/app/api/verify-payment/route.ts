import { NextResponse } from 'next/server'
import { verifyTransaction, paymentMismatchReason } from '@/lib/paystack'
import { activateBandwidth } from '@/lib/bandwidth'
import { createAdminClient } from '@/lib/supabase/server'
import { alertAdminPayment } from '@/lib/paymentAlerts'

export async function POST(req: Request) {
  try {
    let reference: unknown
    try {
      ;({ reference } = await req.json())
    } catch {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }
    if (typeof reference !== 'string' || !reference || reference.length > 100) {
      return NextResponse.json({ error: 'No reference' }, { status: 400 })
    }

    const supabase = await createAdminClient()

    // No user-auth check here, intentionally: this is the browser-redirect
    // fallback for verifying a payment when the webhook hasn't landed yet, so
    // the caller isn't necessarily logged back in when it fires. It is safe
    // without one — `reference` only unlocks the one order it belongs to, the
    // payment is re-verified server-to-server with Paystack (status, amount,
    // currency, reference — nothing is trusted from the client), the credit
    // always goes to the order's own user, and activateBandwidth()'s atomic
    // claim makes a repeated or racing call a no-op rather than a
    // double-credit. The Cloudflare rate-limit binding (lib/rateLimit.ts) now
    // exists; if abuse ever shows up here it can be applied, but a valid
    // reference can only replay the same idempotent credit.
    const { data: order, error } = await supabase
      .from('orders')
      .select('id, user_id, payment_status, amount_usd, gb_amount, paystack_reference, bandwidth_credited, is_canary')
      .eq('paystack_reference', reference)
      .maybeSingle()

    if (error) {
      console.error('[verify-payment] order lookup failed', error)
      return NextResponse.json({ error: 'Could not look up your order. Please try again.' }, { status: 500 })
    }
    if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 })

    // Already processed — don't double credit
    if (order.payment_status === 'paid' || order.bandwidth_credited) {
      return NextResponse.json({ success: true, already_paid: true })
    }

    // Only a refunded order is final. 'cancelled'/'failed' are local labels
    // (new checkout auto-cancel, Cancel button, a declined first attempt, the
    // 24h cleanup) — if Paystack confirms the money arrived, it is credited,
    // exactly as the webhook does.
    if (order.payment_status === 'refunded') {
      return NextResponse.json({ error: 'This order has been refunded.' }, { status: 400 })
    }

    const txn = await verifyTransaction(reference)
    if (txn.status !== 'success') {
      return NextResponse.json({ error: 'Payment not successful' }, { status: 400 })
    }

    const mismatch = paymentMismatchReason(txn, order)
    if (mismatch) {
      console.error('[verify-payment] payment does not match order', { order_id: order.id, mismatch })
      await alertAdminPayment('verify-payment: payment does not match its order — NOT credited', {
        order_id: order.id, reference, problem: mismatch,
      })
      return NextResponse.json({ error: 'Payment amount mismatch. Please contact support.' }, { status: 400 })
    }

    const result = await activateBandwidth({
      order_id: order.id,
      user_id: order.user_id,
      gb_amount: Number(order.gb_amount),
      paystack_reference: reference,
      amount_usd: Number(order.amount_usd),
      is_canary: !!order.is_canary,
    })

    if (result.status === 'error') {
      // Money is confirmed but the credit didn't commit. Don't claim success.
      // Nothing was changed, so the webhook redelivery / reconcile cron will
      // complete it within minutes.
      return NextResponse.json({
        success: false,
        error: "Your payment is confirmed, but we couldn't credit it just yet. It will be credited automatically within a few minutes — contact support if it doesn't appear.",
      }, { status: 503 })
    }

    return NextResponse.json({ success: true, already_paid: result.status === 'already_credited' })
  } catch (err: any) {
    console.error('[verify-payment]', err)
    return NextResponse.json({ error: 'Could not verify payment right now. Please try again shortly.' }, { status: 500 })
  }
}
