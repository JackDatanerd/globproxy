import { appUrl } from '@/lib/appUrl'
import { NextResponse } from 'next/server'
import { verifyWebhookSignature, paymentMismatchReason } from '@/lib/paystack'
import { activateBandwidth } from '@/lib/bandwidth'
import { createAdminClient } from '@/lib/supabase/server'
import { escapeHtml, sendEmail } from '@/lib/email'
import { alertAdminPayment } from '@/lib/paymentAlerts'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

// Response contract with Paystack (it redelivers anything that isn't a 2xx):
//   - 200 once an event is fully handled, or is *permanently* unhandleable
//     (unknown order, mismatch, refunded order…). Those also email the admin —
//     they need a human, and retrying can't change the outcome.
//   - 500 when something transient failed (DB error, RPC error) so Paystack
//     redelivers. Previously every failure — including a failed credit —
//     returned 200, which told Paystack to stop retrying and left a paid
//     order uncredited. The reconcile cron (app/api/cron/[task]) is the
//     second safety net if redelivery is exhausted.
export async function POST(req: Request) {
  const body = await req.text()
  const sig = req.headers.get('x-paystack-signature') ?? ''

  if (!verifyWebhookSignature(body, sig)) {
    console.error('[webhook] signature verification failed')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let event: any
  try {
    event = JSON.parse(body)
  } catch {
    console.error('[webhook] signed body was not valid JSON')
    return NextResponse.json({ received: true })
  }

  try {
    const supabase = await createAdminClient()
    switch (event.event) {
      case 'charge.success':
        return await handleChargeSuccess(supabase, event.data)
      case 'charge.failed':
        await handleChargeFailed(supabase, event.data)
        break
      case 'refund.processed':
        await handleRefundProcessed(supabase, event.data)
        break
      case 'charge.dispute.create':
      case 'charge.dispute.resolve':
        await handleDispute(event.event, event.data)
        break
    }
    return NextResponse.json({ received: true })
  } catch (err: any) {
    console.error('[webhook] transient failure — asking Paystack to redeliver', event?.event, err?.message, err?.stack)
    return NextResponse.json({ error: 'Temporary failure' }, { status: 500 })
  }
}

async function handleChargeSuccess(supabase: Admin, data: any) {
  const reference: string = data?.reference ?? ''
  const metadata = data?.metadata ?? {}
  const amount = Number(data?.amount)
  const currency: string | undefined = data?.currency

  // Prefer the order id we put in metadata; fall back to the reference (unique
  // per order) so a payload without usable metadata can still be matched
  // instead of silently dropped.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const orderId: string = typeof metadata?.order_id === 'string' && UUID_RE.test(metadata.order_id) ? metadata.order_id : ''
  let query = supabase
    .from('orders')
    .select('id, user_id, payment_status, amount_usd, gb_amount, paystack_reference, bandwidth_credited, is_canary')
  query = orderId ? query.eq('id', orderId) : query.eq('paystack_reference', reference)
  const { data: order, error: orderErr } = await query.maybeSingle()

  if (orderErr) throw orderErr // transient — let Paystack retry

  if (!order) {
    console.error('[webhook] charge.success for unknown order', { reference, orderId })
    await alertAdminPayment('Payment received for an unknown order', {
      reference, order_id: orderId || '(none in metadata)', amount_cents: amount, currency: currency ?? 'unknown',
    })
    return NextResponse.json({ received: true })
  }

  if (order.payment_status === 'paid' || order.bandwidth_credited) {
    return NextResponse.json({ received: true }) // already handled
  }

  // 'pending', 'cancelled' and 'failed' orders are all creditable once
  // Paystack confirms real money arrived: a cancelled/failed label is only our
  // local bookkeeping (new checkout auto-cancel, Cancel button, an earlier
  // declined attempt, the 24h cleanup) and must never decide whether a
  // customer who actually paid gets their bandwidth. Only 'refunded' is final.
  if (order.payment_status === 'refunded') {
    console.error('[webhook] charge.success for a refunded order', { order_id: order.id })
    await alertAdminPayment('charge.success arrived for an already-refunded order', {
      order_id: order.id, reference,
    })
    return NextResponse.json({ received: true })
  }

  const mismatch = paymentMismatchReason({ amount, currency, reference }, order)
  if (mismatch) {
    console.error('[webhook] payment does not match order — refusing to credit', { order_id: order.id, mismatch })
    await alertAdminPayment('Payment does not match its order — NOT credited', {
      order_id: order.id, reference, problem: mismatch, order_status: order.payment_status,
    })
    return NextResponse.json({ received: true })
  }

  // The order row is the single source of truth for who gets how much.
  const result = await activateBandwidth({
    order_id: order.id,
    user_id: order.user_id,
    gb_amount: Number(order.gb_amount),
    paystack_reference: reference,
    amount_usd: Number(order.amount_usd),
    is_canary: !!order.is_canary,
  })
  if (result.status === 'error') {
    // Nothing was committed. Non-200 → Paystack redelivers; the reconcile
    // cron also picks it up if redelivery runs out.
    throw new Error(`activateBandwidth failed for order ${order.id}: ${result.error}`)
  }

  // Canary bootstrap: capture a reusable authorization_code for the daily
  // canary charge (see cron 'canary'). Best-effort — the credit is committed,
  // so nothing here may turn this delivery into a failure.
  try {
    const { data: canarySetting } = await supabase
      .from('platform_settings').select('value').eq('key', 'canary_user_id').maybeSingle()
    if (canarySetting?.value && canarySetting.value === order.user_id) {
      const auth = data?.authorization
      if (auth?.reusable && auth?.authorization_code) {
        await supabase.from('platform_settings').upsert(
          { key: 'canary_authorization_code', value: auth.authorization_code },
          { onConflict: 'key' },
        )
      }
    }
  } catch (e) {
    console.error('[webhook] canary authorization capture failed', e)
  }

  return NextResponse.json({ received: true })
}

async function handleChargeFailed(supabase: Admin, data: any) {
  const reference = data?.reference ?? ''
  const gateway_response = data?.gateway_response
  // Same validation as handleChargeSuccess: a non-UUID order_id used to reach
  // .eq('id', …), Postgres rejected it, we threw, and Paystack redelivered
  // the malformed event forever. Fall back to the unique reference.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const metaOrderId = data?.metadata?.order_id
  const order_id: string = typeof metaOrderId === 'string' && UUID_RE.test(metaOrderId) ? metaOrderId : ''

  let orderQuery = supabase.from('orders').select('id, payment_status, amount_usd, gb_amount, user_id')
  const lookup = order_id ? orderQuery.eq('id', order_id) : (reference ? orderQuery.eq('paystack_reference', reference) : null)
  const { data: order, error } = lookup ? await lookup.maybeSingle() : { data: null, error: null }
  if (error) throw error

  // A decline on one attempt is not final: the customer can retry another
  // card on the same Paystack session, and a later charge.success is still
  // credited (see handleChargeSuccess). Marking it 'failed' here is purely
  // informational.
  if (order && order.payment_status === 'pending') {
    await supabase.from('orders').update({
      payment_status: 'failed',
      failure_reason: gateway_response ?? 'Declined',
      failed_at: new Date().toISOString(),
    }).eq('id', order.id)
  }

  const customerEmail = escapeHtml(data?.customer?.email ?? 'unknown')
  const safeReason = escapeHtml(gateway_response ?? 'not provided')
  await sendEmail({
    to: process.env.ADMIN_EMAIL ?? '',
    subject: `[PAYMENT FAILED] ${gateway_response ?? 'Declined'} — $${order?.amount_usd ?? '?'}`,
    html: `<p><strong>Customer:</strong> ${customerEmail}</p>
           <p><strong>Amount:</strong> $${order?.amount_usd ?? 'unknown'} (${order?.gb_amount ?? '?'} GB)</p>
           <p><strong>Reference:</strong> ${escapeHtml(reference)}</p>
           <p><strong>Paystack reason:</strong> ${safeReason}</p>
           <p>Order marked 'failed' immediately. If the customer retries successfully on the same checkout it will still be credited automatically.</p>
           <a href="${appUrl()}/admin">Open admin panel →</a>`,
  }).catch((e) => console.error('[webhook] charge.failed alert email threw', e))
}

// Paystack refund.processed: the money is already back with the customer, so
// take the proportional bandwidth back (never below what's already allocated
// to credentials — the shortfall is reported) and mark the order refunded.
// apply_order_refund is idempotent per refund reference.
async function handleRefundProcessed(supabase: Admin, data: any) {
  if (data?.status && data.status !== 'processed') return

  const txRef: string = data?.transaction_reference ?? data?.transaction?.reference ?? ''
  const refundCents = Number(data?.amount)
  const refundRef: string = String(data?.refund_reference ?? data?.id ?? `${txRef}_${refundCents}`)

  if (!txRef || !Number.isFinite(refundCents) || refundCents <= 0) {
    await alertAdminPayment('refund.processed with an unreadable payload — handle manually', {
      transaction_reference: txRef || '(missing)', amount: data?.amount, refund_reference: refundRef,
    })
    return
  }

  const { data: order, error } = await supabase
    .from('orders').select('id, user_id, amount_usd, gb_amount, is_canary').eq('paystack_reference', txRef).maybeSingle()
  if (error) throw error
  if (!order) {
    await alertAdminPayment('Refund processed for an unknown order', { transaction_reference: txRef, refund_reference: refundRef })
    return
  }

  const { data: result, error: rpcErr } = await supabase.rpc('apply_order_refund', {
    p_order_id: order.id,
    p_refund_reference: refundRef,
    p_refund_usd: refundCents / 100,
  })
  if (rpcErr) throw rpcErr

  if (result?.applied) {
    await alertAdminPayment('Refund applied', {
      order_id: order.id, refund_usd: result.refund_usd, gb_clawed_back: result.gb_clawed,
      gb_not_recoverable: result.gb_shortfall, fully_refunded: result.fully_refunded,
      note: 'If this order came through a referral/affiliate, its commission is NOT reversed automatically — review it in admin.',
    })
  } else if (result?.reason !== 'duplicate') {
    await alertAdminPayment('Refund could not be applied automatically', {
      order_id: order.id, refund_reference: refundRef, reason: result?.reason ?? 'unknown',
    })
  }
}

// Disputes can be won, so nothing is clawed back automatically — the admin
// is told immediately because Paystack's response window is short.
async function handleDispute(kind: string, data: any) {
  await alertAdminPayment(kind === 'charge.dispute.create' ? 'DISPUTE OPENED — respond in Paystack' : 'Dispute resolved', {
    transaction_reference: data?.transaction?.reference ?? data?.transaction_reference ?? '(unknown)',
    status: data?.status ?? '', resolution: data?.resolution ?? '', refund_amount: data?.refund_amount ?? '',
    category: data?.category ?? '',
  })
}
