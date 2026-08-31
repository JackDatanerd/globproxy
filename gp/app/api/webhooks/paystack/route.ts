import { NextResponse } from 'next/server'
import { verifyWebhookSignature, amountMatchesOrder } from '@/lib/paystack'
import { activateBandwidth } from '@/lib/bandwidth'
import { createAdminClient } from '@/lib/supabase/server'


export async function POST(req: Request) {
  try {
    const body = await req.text()
    const sig = req.headers.get('x-paystack-signature') ?? ''

    if (!verifyWebhookSignature(body, sig)) {
      console.error('[webhook] signature verification failed')
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    const event = JSON.parse(body)

    if (event.event === 'charge.success') {
      const { reference, metadata, amount } = event.data

      const order_id  = metadata?.order_id  ?? ''
      const user_id   = metadata?.user_id   ?? ''
      const gb_amount = Number(metadata?.gb_amount ?? 0)

      if (!order_id || !user_id || !gb_amount) {
        console.error('[webhook] missing metadata', { order_id, user_id, gb_amount })
        return NextResponse.json({ received: true })
      }

      const supabase = await createAdminClient()
      const { data: order, error: orderErr } = await supabase
        .from('orders')
        .select('payment_status, amount_usd, gb_amount')
        .eq('id', order_id)
        .single()

      // Previously fell through to activateBandwidth() on a failed lookup —
      // `order` would be undefined, so `order && !amountMatchesOrder(...)`
      // short-circuited to false and skipped the mismatch check entirely.
      // It was saved from double-crediting only by activateBandwidth()'s
      // atomic claim (UPDATE ... WHERE id = order_id AND bandwidth_credited
      // = false), which matches zero rows for a nonexistent order_id — but
      // that's an implicit side effect, not an explicit guard. Bail out
      // here instead so the intent is visible in this file.
      if (orderErr || !order) {
        console.error('[webhook] order lookup failed — refusing to credit', { order_id, orderErr })
        return NextResponse.json({ received: true })
      }

      if (order.payment_status === 'paid') {
        return NextResponse.json({ received: true })
      }

      // Only a 'pending' order should ever be credited. Previously the only
      // guard here was the 'paid' check above — an order sitting in
      // 'cancelled' (e.g. api/checkout auto-cancels a user's other pending
      // orders when they start a new checkout) or 'failed' (cron cleanup)
      // would still fall through and get credited if Paystack later fired
      // charge.success for it (a stale checkout tab completed after the
      // order moved on). Not a way to get bandwidth without paying —
      // amountMatchesOrder + verifyTransaction below still require a real,
      // matching payment — but it left orders permanently mislabeled
      // ('cancelled' in billing history while actually credited).
      if (order.payment_status !== 'pending') {
        console.error('[webhook] order is not pending — refusing to credit', {
          order_id, status: order.payment_status,
        })
        return NextResponse.json({ received: true })
      }

      // Cross-check what Paystack actually charged against what the order
      // expects, rather than trusting status:success + metadata alone.
      if (!amountMatchesOrder(amount, order.amount_usd)) {
        console.error('[webhook] amount mismatch — refusing to credit', {
          order_id, paid_cents: amount, expected_usd: order.amount_usd,
        })
        return NextResponse.json({ received: true })
      }

      // Use the DB's own gb_amount as the source of truth for what actually
      // gets credited, matching verify-payment/route.ts — metadata.gb_amount
      // above is only used for the early presence check before the order is
      // fetched. Paystack only ever echoes back what checkout set server-side
      // (not client-mutable), so this wasn't exploitable either way, but two
      // different sources of truth for the same value is worth collapsing
      // into one now that the order row is already in hand.
      await activateBandwidth({ order_id, user_id, gb_amount: Number(order.gb_amount), paystack_reference: reference, amount_usd: Number(order.amount_usd) })
    }

    return NextResponse.json({ received: true })
  } catch (err: any) {
    console.error('[webhook] CRASH', err?.message, err?.stack)
    return NextResponse.json({ received: true }) // always 200 so Paystack stops retrying
  }
}