import { createAdminClient, createClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { initializeTransaction, generateReference } from '@/lib/paystack'
import { resolveOrder } from '@/lib/plans'
import { getKesQuote, kesFor } from '@/lib/fx'
import { appUrl, isCrossSiteRequest } from '@/lib/appUrl'
import { rateLimited } from '@/lib/rateLimit'
import { NextResponse } from 'next/server'

// Who is calling? The dashboard's buy page authenticates with the browser's
// session cookie (nothing client-side has to read the access token), while
// scripts may still send `Authorization: Bearer <access token>`. This route
// used to accept ONLY the Bearer header, so the moment the buy page stopped
// attaching it every checkout answered 401 — a revenue outage caused by a
// UI-only change. Cookie first, Bearer as a fallback, so neither client can
// break the other again.
async function resolveCaller(req: Request): Promise<{ id: string; email: string | null; viaCookie: boolean } | null> {
  const bearer = req.headers.get('authorization')?.match(/^Bearer\s+(\S+)\s*$/i)?.[1]
  if (bearer) {
    const admin = await createAdminClient()
    const { data: { user } } = await admin.auth.getUser(bearer)
    return user ? { id: user.id, email: user.email ?? null, viaCookie: false } : null
  }
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  return user ? { id: user.id, email: user.email ?? null, viaCookie: true } : null
}

export async function POST(req: Request) {
  try {
    const caller = await resolveCaller(req)
    if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (caller.viaCookie && isCrossSiteRequest(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const limited = await rateLimited(req, 'PAYMENT_RATE_LIMITER', caller.id)
    if (limited) return limited

    const user = { id: caller.id, email: caller.email }
    const supabase = await createAdminClient()

    const suspended = await requireActiveUser(user.id)
    if (suspended) return suspended

    // A payment dispute (chargeback) is open on this account: no new purchases
    // until it is settled — otherwise buy → use → dispute can be repeated.
    const { data: openDispute, error: disputeErr } = await supabase
      .from('orders').select('id').eq('user_id', user.id).eq('dispute_status', 'open').limit(1)
    // Secondary control: if this lookup fails, log it and let the purchase
    // proceed rather than turning a DB hiccup into a checkout outage.
    if (disputeErr) console.error('[checkout] dispute lookup failed', disputeErr)
    if (openDispute && openDispute.length > 0) {
      return NextResponse.json({
        error: 'New purchases are paused while a payment dispute on your account is open. Please contact support@globproxy.com.',
      }, { status: 403 })
    }

    let body: any
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }
    // A fixed plan, or a custom GB quantity — priced here, never trusted from the client.
    const planData = resolveOrder(body?.plan, body?.gb)
    if (!planData) return NextResponse.json({ error: 'Invalid plan' }, { status: 400 })

    const method: 'card' | 'mpesa' = body?.method === 'mpesa' ? 'mpesa' : 'card'
    let kes: { amount: number; rate: number } | null = null
    if (method === 'mpesa') {
      const quote = await getKesQuote(supabase)
      if (!quote) {
        return NextResponse.json({ error: 'M-Pesa is temporarily unavailable. Please pay by card or try again later.' }, { status: 503 })
      }
      const amount = kesFor(planData.total, quote.rate)
      // The customer saw a KES price on the buy page. If the rate has refreshed
      // since and the price moved by more than a rounding hair, make them
      // re-confirm the new amount rather than charging a number they didn't see.
      const expected = Number(body?.expected_kes)
      if (Number.isFinite(expected) && expected > 0 && Math.abs(amount / expected - 1) > 0.01) {
        return NextResponse.json({
          error: 'The exchange rate just updated. Please review the new amount and try again.',
          rate_changed: true, rate: quote.rate, amount_kes: amount,
        }, { status: 409 })
      }
      kes = { amount, rate: quote.rate }
    }

    if (!user.email) {
      return NextResponse.json({ error: 'Your account has no email address. Add one before purchasing.' }, { status: 400 })
    }
    const base = appUrl()

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
      payment_method: method === 'mpesa' ? 'mpesa' : 'paystack',
      payment_status: 'pending',
      paystack_reference: reference,
      // M-Pesa: the KES amount the customer is asked to pay, locked now, plus the
      // rate it came from. Verification expects exactly this, not the USD price.
      ...(kes ? { pay_currency: 'KES', pay_amount: kes.amount, fx_rate: kes.rate } : {}),
    }).select().single()

    if (error || !order) throw error ?? new Error('order insert returned no row')

    let txn
    try {
      txn = await initializeTransaction({
        email: user.email,
        amount_usd: planData.total,
        ...(kes ? { currency: 'KES' as const, amount_major: kes.amount, channels: ['mobile_money'] } : {}),
        reference,
        metadata: {
          order_id: order.id,
          user_id: user.id,
          gb_amount: String(planData.gb),
          plan: planData.slug,
          ...(kes ? { currency: 'KES', amount_kes: String(kes.amount) } : {}),
        },
        callback_url: `${base}/dashboard?payment=success&reference=${reference}`,
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
      ...(kes ? { amount_kes: kes.amount } : {}),
    })
  } catch (err: any) {
    console.error('Checkout error:', err)
    return NextResponse.json({ error: 'Could not start checkout. Please try again.' }, { status: 500 })
  }
}
