import { NextResponse } from 'next/server'
import { verifyTransaction, amountMatchesOrder } from '@/lib/paystack'
import { activateBandwidth } from '@/lib/bandwidth'
import { createAdminClient } from '@/lib/supabase/server'

export async function POST(req: Request) {
  try {
    const { reference } = await req.json()
    if (!reference) return NextResponse.json({ error: 'No reference' }, { status: 400 })

    const supabase = await createAdminClient()

    // No user-auth check here, intentionally: this is the browser-redirect
    // fallback path for verifying a payment when the webhook hasn't landed
    // yet, so the caller isn't necessarily logged back in at the moment it
    // fires. It's still safe without one — `reference` only unlocks the one
    // order it belongs to, the amount is re-verified server-to-server with
    // Paystack (not trusted from the client), and activateBandwidth()'s
    // atomic bandwidth_credited claim makes a repeated or racing call a
    // no-op rather than a double-credit. No rate limiting either — nothing
    // else in this app has any (no rate-limit infra exists yet), and a
    // valid reference here can only replay the same already-idempotent
    // credit, so throttling wouldn't change the exposure. If real
    // rate-limiting infra gets added for other routes, this one should get
    // it too as a defense-in-depth measure, not because of a known gap.
    const { data: order, error } = await supabase
      .from('orders')
      .select('*')
      .eq('paystack_reference', reference)
      .single()

    if (error || !order) return NextResponse.json({ error: 'Order not found' }, { status: 404 })

    // Already processed — don't double credit
    if (order.payment_status === 'paid') {
      return NextResponse.json({ success: true, already_paid: true })
    }

    // Same gap as the webhook had (see app/api/webhooks/paystack/route.ts):
    // only a 'pending' order should ever be creditable. Without this, a
    // 'cancelled' or 'failed' order whose stale Paystack reference still
    // verifies as successful would get credited here too, leaving it
    // permanently mislabeled in billing history despite being paid.
    if (order.payment_status !== 'pending') {
      console.error('[verify-payment] order is not pending — refusing to credit', {
        order_id: order.id, status: order.payment_status,
      })
      return NextResponse.json({ error: 'This order is no longer available for payment.' }, { status: 400 })
    }

    // Verify with Paystack directly
    const txn = await verifyTransaction(reference)
    if (txn.status !== 'success') {
      return NextResponse.json({ error: 'Payment not successful' }, { status: 400 })
    }

    if (!amountMatchesOrder(txn.amount, order.amount_usd)) {
      console.error('[verify-payment] amount mismatch', {
        order_id: order.id, paid_cents: txn.amount, expected_usd: order.amount_usd,
      })
      return NextResponse.json({ error: 'Amount mismatch' }, { status: 400 })
    }

    // Activate bandwidth
    await activateBandwidth({
      order_id: order.id,
      user_id: order.user_id,
      gb_amount: Number(order.gb_amount),
      paystack_reference: reference,
      amount_usd: Number(order.amount_usd),
    })

    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('[verify-payment]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}