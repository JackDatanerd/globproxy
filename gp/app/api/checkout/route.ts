import { createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { initializeTransaction, generateReference } from '@/lib/paystack'
import { getPurchasablePlan } from '@/lib/plans'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  try {
    const token = req.headers.get('authorization')?.replace('Bearer ', '')
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const supabase = await createAdminClient()
    const { data: { user } } = await supabase.auth.getUser(token)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const suspended = await requireActiveUser(user.id)
    if (suspended) return suspended

    let plan: unknown
    try {
      ;({ plan } = await req.json())
    } catch {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }
    const planData = typeof plan === 'string' ? getPurchasablePlan(plan) : undefined
    if (!planData) return NextResponse.json({ error: 'Invalid plan' }, { status: 400 })

    if (!user.email) {
      return NextResponse.json({ error: 'Your account has no email address. Add one before purchasing.' }, { status: 400 })
    }
    const appUrl = process.env.NEXT_PUBLIC_APP_URL
    if (!appUrl) {
      console.error('Checkout error: NEXT_PUBLIC_APP_URL is not configured')
      return NextResponse.json({ error: 'Checkout is temporarily unavailable. Please contact support.' }, { status: 500 })
    }

    const reference = generateReference()

    // Create the new order and initialize it with Paystack FIRST. Older
    // pending orders are only retired after that succeeds — previously they
    // were cancelled up front, so a failed initialize left the customer with
    // no live order, and (before late-payment recovery) a paid-but-cancelled
    // one in another tab.
    const { data: order, error } = await supabase.from('orders').insert({
      user_id: user.id,
      gb_amount: planData.gb,
      amount_usd: planData.total,
      payment_method: 'paystack',
      payment_status: 'pending',
      paystack_reference: reference,
    }).select().single()

    if (error || !order) throw error ?? new Error('order insert returned no row')

    let txn
    try {
      txn = await initializeTransaction({
        email: user.email,
        amount_usd: planData.total,
        reference,
        metadata: {
          order_id: order.id,
          user_id: user.id,
          gb_amount: String(planData.gb),
          plan: planData.slug,
        },
        callback_url: `${appUrl}/dashboard?payment=success&reference=${reference}`,
      })
    } catch (initErr) {
      // The reference never reached Paystack, so nothing can ever be paid
      // against this order — drop it instead of leaving an orphan 'pending'.
      const { error: delErr } = await supabase.from('orders').delete().eq('id', order.id)
      if (delErr) {
        await supabase.from('orders').update({
          payment_status: 'cancelled', failure_reason: 'checkout initialization failed', failed_at: new Date().toISOString(),
        }).eq('id', order.id)
      }
      throw initErr
    }

    // Retire the customer's other pending orders so the history doesn't pile
    // up with abandoned checkouts. Safe even if one of them is still being
    // paid in another tab: the webhook / verify-payment / reconcile cron credit
    // any order Paystack confirms as paid, whatever its local status.
    await supabase
      .from('orders')
      .update({ payment_status: 'cancelled' })
      .eq('user_id', user.id)
      .eq('payment_status', 'pending')
      .neq('id', order.id)

    return NextResponse.json({
      url: txn.authorization_url,
      access_code: txn.access_code,
      reference,
    })
  } catch (err: any) {
    console.error('Checkout error:', err)
    return NextResponse.json({ error: 'Could not start checkout. Please try again.' }, { status: 500 })
  }
}
