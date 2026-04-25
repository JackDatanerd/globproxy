import { createAdminClient } from '@/lib/supabase/server'
import { initializeTransaction, generateReference } from '@/lib/paystack'
import { NextResponse } from 'next/server'

const PLANS: Record<string, { gb: number; price: number; total: number }> = {
  micro:   { gb: 1,   price: 4.50, total: 4.50  },
  starter: { gb: 10,  price: 3.50, total: 35.00 },
  growth:  { gb: 100, price: 2.80, total: 280.00 },
}

export async function POST(req: Request) {
  try {
    const token = req.headers.get('authorization')?.replace('Bearer ', '')
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const supabase = await createAdminClient()
    const { data: { user } } = await supabase.auth.getUser(token)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { plan } = await req.json()
    const planData = PLANS[plan]
    if (!planData) return NextResponse.json({ error: 'Invalid plan' }, { status: 400 })

    // Cancel any existing pending orders to prevent duplicates
    await supabase
      .from('orders')
      .update({ payment_status: 'cancelled' })
      .eq('user_id', user.id)
      .eq('payment_status', 'pending')

    const reference = generateReference()

    const { data: order, error } = await supabase.from('orders').insert({
      user_id: user.id,
      gb_amount: planData.gb,
      amount_usd: planData.total,
      payment_method: 'paystack',
      payment_status: 'pending',
      paystack_reference: reference,
    }).select().single()

    if (error) throw error

    const txn = await initializeTransaction({
      email: user.email!,
      amount_usd: planData.total,
      reference,
      metadata: {
        order_id: order.id,
        user_id: user.id,
        gb_amount: String(planData.gb),
      },
      callback_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?payment=success&reference=${reference}`,
    })

    return NextResponse.json({ url: txn.authorization_url })
  } catch (err: any) {
    console.error('Checkout error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}