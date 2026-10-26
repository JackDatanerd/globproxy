import { NextResponse } from 'next/server'
import { verifyTransaction, paymentMismatchReason } from '@/lib/paystack'
import { activateBandwidth } from '@/lib/bandwidth'
import { createAdminClient } from '@/lib/supabase/server'
import { alertMismatchOnce } from '@/lib/paymentAlerts'
import { rateLimited } from '@/lib/rateLimit'
import { failPendingOrder } from '@/lib/orderFailure'
import { captureSavedCardIfRequested } from '@/lib/autoRecharge'

// The answer for anything that is OUR or the provider's hiccup rather than a
// verdict on the payment. The client polls on `pending` and tells the customer it
// is "still processing"; it used to get a bare 500, read that as a definitive
// failure and showed a red error to someone whose money may well have moved.
function stillConfirming(message = 'We could not confirm your payment just yet — it will be credited automatically once it is confirmed.') {
  return NextResponse.json({ success: false, pending: true, error: message }, { status: 503 })
}

export async function POST(req: Request) {
  try {
    // Unauthenticated by design (see below), so cap it: each call that reaches a
    // real reference spends Paystack API quota shared with the reconcile cron and
    // every genuine customer.
    // Two buckets. Per address only (loose): many customers share one mobile-
    // carrier address and each polls every few seconds. Per address AND
    // reference (below, once the body is read): bounds the calls for ONE payment.
    // They were a single 30/min bucket per address, which two M-Pesa customers
    // on the same carrier address polling at 20/min each exhausted.
    const ipLimited = await rateLimited(req, 'PAYMENT_VERIFY_RATE_LIMITER')
    if (ipLimited) return ipLimited

    let reference: unknown
    try {
      ;({ reference } = await req.json())
    } catch {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }
    if (typeof reference !== 'string' || !reference || reference.length > 100) {
      return NextResponse.json({ error: 'No reference' }, { status: 400 })
    }

    const limited = await rateLimited(req, 'PAYMENT_RATE_LIMITER', `verify:${reference}`)
    if (limited) return limited

    const supabase = await createAdminClient()

    // No user-auth check here, intentionally: this is the browser-redirect
    // fallback for verifying a payment when the webhook hasn't landed yet, so
    // the caller isn't necessarily logged back in when it fires. It is safe
    // without one — `reference` only unlocks the one order it belongs to, the
    // payment is re-verified server-to-server with Paystack (status, amount,
    // currency, reference — nothing is trusted from the client), the credit
    // always goes to the order's own user, and activateBandwidth()'s atomic
    // claim makes a repeated or racing call a no-op rather than a
    // double-credit. It is rate-limited per address (above); a valid
    // reference can only replay the same idempotent credit.
    const { data: order, error } = await supabase
      .from('orders')
      .select('id, user_id, payment_status, payment_method, amount_usd, gb_amount, paystack_reference, bandwidth_credited, is_canary, pay_currency, pay_amount, created_at')
      .eq('paystack_reference', reference)
      .maybeSingle()

    if (error) {
      console.error('[verify-payment] order lookup failed', error)
      return stillConfirming()
    }
    if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 })

    // A refunded order is final — and answered FIRST: a refunded order was credited before it
    // was refunded, so the 'already processed' branch below would otherwise tell someone
    // reopening an old callback link "payment successful" for money that was returned.
    // Only a refunded order is final. 'cancelled'/'failed' are local labels
    // (new checkout auto-cancel, Cancel button, a declined first attempt, the
    // 24h cleanup) — if Paystack confirms the money arrived, it is credited,
    // exactly as the webhook does.
    if (order.payment_status === 'refunded') {
      return NextResponse.json({ error: 'This order has been refunded.' }, { status: 400 })
    }

    // Already processed — don't double credit
    if (order.payment_status === 'paid' || order.bandwidth_credited) {
      return NextResponse.json({ success: true, already_paid: true })
    }

    let txn: Awaited<ReturnType<typeof verifyTransaction>>
    try {
      txn = await verifyTransaction(reference)
    } catch (e) {
      // Paystack unreachable / timing out / not (yet) aware of the reference:
      // nothing is known about the payment, so the customer is told to wait.
      console.error('[verify-payment] Paystack verify failed', order.id, e)
      // A reference Paystack has never seen (checkout abandoned before it registered
      // the transaction) is a verdict, not a hiccup — once the order is old enough
      // that registration lag is ruled out, say so instead of "still confirming".
      const ageMs = order.created_at ? Date.now() - Date.parse(order.created_at) : 0
      if (/not found/i.test(String((e as any)?.message ?? '')) && Number.isFinite(ageMs) && ageMs > 10 * 60 * 1000) {
        return NextResponse.json({ error: 'The payment was not completed. You have not been charged.' }, { status: 400 })
      }
      return stillConfirming()
    }
    if (txn.status !== 'success') {
      // Not-yet-final states are NOT failures: a card awaiting 3-D Secure/OTP,
      // or a redirect that returned before the charge settled, still ends in
      // charge.success. Tell the client to keep waiting (it polls) instead of
      // showing a red "failed" for money that is about to arrive.
      if (['ongoing', 'pending', 'processing', 'queued', 'pay_offline'].includes(txn.status)) {
        return NextResponse.json({ success: false, pending: true, error: 'Your payment is still being processed.' }, { status: 202 })
      }
      if (txn.status === 'reversed') {
        return NextResponse.json({ error: 'This payment was reversed.' }, { status: 400 })
      }
      if (txn.status === 'abandoned') {
        // An M-Pesa customer who has not yet entered their PIN on the STK push
        // can read as 'abandoned' to the provider; ending the wait now would show
        // a failure to someone mid-payment. Give a fresh M-Pesa order ten minutes
        // (the prompt itself lapses long before that).
        if (order.payment_method === 'mpesa' && Date.now() - Date.parse(order.created_at) < 10 * 60 * 1000) {
          return NextResponse.json({ success: false, pending: true, error: 'Waiting for you to confirm the M-Pesa prompt on your phone.' }, { status: 202 })
        }
        return NextResponse.json({ error: 'The payment was not completed. You have not been charged.' }, { status: 400 })
      }
      // A real decline. Paystack documents no charge.failed webhook, so this is
      // one of the places the failed state is recorded (and the customer told).
      // Best-effort: the answer below must not depend on it.
      if (txn.status === 'failed' && order.payment_status === 'pending') {
        try {
          await failPendingOrder(supabase, order, txn.gateway_response ?? null, { source: 'verify-payment', alertAdmin: true })
        } catch (e) {
          console.error('[verify-payment] could not record the failed payment', order.id, e)
        }
      }
      return NextResponse.json({ error: txn.gateway_response ? `Payment not successful: ${txn.gateway_response}` : 'Payment not successful' }, { status: 400 })
    }

    const mismatch = paymentMismatchReason(txn, order)
    if (mismatch) {
      console.error('[verify-payment] payment does not match order', { order_id: order.id, mismatch })
      await alertMismatchOnce(supabase, order.id, 'verify-payment: payment does not match its order — NOT credited', {
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
        delayed: true,
        error: "Your payment is confirmed, but we couldn't credit it just yet. It will be credited automatically within a few minutes — contact support if it doesn't appear.",
      }, { status: 503 })
    }

    // The customer asked to keep this card: when this call (not the webhook) is the one that
    // saw the payment, the webhook may never land, so store it here too. Best-effort.
    await captureSavedCardIfRequested(supabase, order, txn.metadata, txn)

    return NextResponse.json({ success: true, already_paid: result.status === 'already_credited' })
  } catch (err: any) {
    console.error('[verify-payment]', err)
    return stillConfirming('Could not verify payment right now.')
  }
}
