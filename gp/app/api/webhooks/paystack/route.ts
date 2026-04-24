import { NextResponse } from 'next/server'
import { verifyWebhookSignature } from '@/lib/paystack'
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
      const { reference, metadata } = event.data

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
        .select('payment_status')
        .eq('id', order_id)
        .single()

      console.log('[webhook] order lookup', { order, orderErr })

      if (order?.payment_status === 'paid') {
        console.log('[webhook] already paid, skipping')
        return NextResponse.json({ received: true })
      }

      await activateBandwidth({ order_id, user_id, gb_amount, paystack_reference: reference })
      console.log('[webhook] activateBandwidth complete')
    }

    return NextResponse.json({ received: true })
  } catch (err: any) {
    console.error('[webhook] CRASH', err?.message, err?.stack)
    return NextResponse.json({ received: true }) // always 200 so Paystack stops retrying
  }
}