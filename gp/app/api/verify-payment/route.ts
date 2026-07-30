import { NextResponse } from 'next/server'
import { verifyTransaction, amountMatchesOrder } from '@/lib/paystack'
import { activateBandwidth } from '@/lib/bandwidth'
import { createAdminClient } from '@/lib/supabase/server'

export async function POST(req: Request) {
  try {
    const { reference } = await req.json()
    if (!reference) return NextResponse.json({ error: 'No reference' }, { status: 400 })

    const supabase = await createAdminClient()

    // Find the order by reference
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
    })

    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('[verify-payment]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}