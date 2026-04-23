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
    const fields = metadata?.custom_fields as Array<{ variable_name: string; value: string }> ?? []
    const get = (k: string) => fields.find(f => f.variable_name === k)?.value ?? ''

    const order_id = get('order_id')
    const user_id = get('user_id')
    const gb_amount = Number(get('gb_amount'))

    if (!order_id || !user_id || !gb_amount) {
      console.error('Missing metadata in Paystack webhook', { order_id, user_id, gb_amount })
      return NextResponse.json({ received: true })
    }

    // Verify not already processed
    const supabase = await createAdminClient()
    const { data: order } = await supabase.from('orders').select('payment_status').eq('id', order_id).single()
    if (order?.payment_status === 'paid') return NextResponse.json({ received: true })

    await activateBandwidth({ order_id, user_id, gb_amount, paystack_reference: reference })
  }

  return NextResponse.json({ received: true })
}
