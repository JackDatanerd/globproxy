import { NextResponse } from 'next/server'
import { verifyWebhookSignature, amountMatchesOrder } from '@/lib/paystack'
import { activateBandwidth } from '@/lib/bandwidth'
import { createAdminClient } from '@/lib/supabase/server'

export const runtime = 'edge'

export async function POST(req: Request) {
  try {
    const body = await req.text()
    const sig = req.headers.get('x-paystack-signature') ?? ''

    console.log('[webhook] hit', { sigPresent: !!sig, bodyLength: body.length })

    if (!verifyWebhookSignature(body, sig)) {
      console.log('[webhook] signature FAILED')
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    console.log('[webhook] signature OK')

    const event = JSON.parse(body)
    console.log('[webhook] event type:', event.event)
    console.log('[webhook] metadata:', JSON.stringify(event.data?.metadata))

    if (event.event === 'charge.success') {
      const { reference, metadata, amount } = event.data

      const order_id  = metadata?.order_id  ?? ''
      const user_id   = metadata?.user_id   ?? ''
      const gb_amount = Number(metadata?.gb_amount ?? 0)

      console.log('[webhook] parsed', { order_id, user_id, gb_amount })

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

      console.log('[webhook] order lookup', { order, orderErr })

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
        console.log('[webhook] already paid, skipping')
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
      await activateBandwidth({ order_id, user_id, gb_amount: Number(order.gb_amount), paystack_reference: reference })
      console.log('[webhook] activateBandwidth complete')
    }

    return NextResponse.json({ received: true })
  } catch (err: any) {
    console.error('[webhook] CRASH', err?.message, err?.stack)
    return NextResponse.json({ received: true }) // always 200 so Paystack stops retrying
  }
}