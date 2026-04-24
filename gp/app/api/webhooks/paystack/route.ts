import { NextResponse } from 'next/server'
import { verifyWebhookSignature } from '@/lib/paystack'
import { activateBandwidth } from '@/lib/bandwidth'
import { createAdminClient } from '@/lib/supabase/server'

export async function POST(req: Request) {
  const body = await req.text()
  const sig = req.headers.get('x-paystack-signature') ?? ''

  if (!verifyWebhookSignature(body, sig)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const event = JSON.parse(body)

  if (event.event === 'charge.success') {
    const { reference, metadata } = event.data

    // Metadata is a flat object — match how checkout sends it
    const order_id  = metadata?.order_id  ?? ''
    const user_id   = metadata?.user_id   ?? ''
    const gb_amount = Number(metadata?.gb_amount ?? 0)

    if (!order_id || !user_id || !gb_amount) {
      console.error('Missing metadata in Paystack webhook', { order_id, user_id, gb_amount })
      return NextResponse.json({ received: true })
    }

    const supabase = await createAdminClient()

    // Idempotency — don't process twice
    const { data: order } = await supabase
      .from('orders')
      .select('payment_status')
      .eq('id', order_id)
      .single()

    if (order?.payment_status === 'paid') {
      return NextResponse.json({ received: true })
    }

    await activateBandwidth({ order_id, user_id, gb_amount, paystack_reference: reference })
  }

  return NextResponse.json({ received: true })
}