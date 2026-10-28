import { appUrl } from '@/lib/appUrl'
import { NextResponse } from 'next/server'
import { verifyWebhookSignature, paymentMismatchReason } from '@/lib/paystack'
import { activateBandwidth } from '@/lib/bandwidth'
import { createAdminClient } from '@/lib/supabase/server'
import { escapeHtml, sendEmail } from '@/lib/email'
import { alertAdminPayment, alertMismatchOnce } from '@/lib/paymentAlerts'
import { sendRefundEmail } from '@/lib/billingEmails'
import { dispatchWebhook } from '@/lib/webhooks'
import { snapshotCommission, notifyCommissionRefunded } from '@/lib/affiliateNotify'
import { failPendingOrder } from '@/lib/orderFailure'
import { applyDisputeLoss } from '@/lib/disputes'
import { captureSavedCardIfRequested } from '@/lib/autoRecharge'
import { sendDisputeOpenedEmail } from '@/lib/billingEmails'

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
      case 'refund.failed':
      case 'refund.needs-attention':
        await handleRefundProblem(supabase, event.event, event.data)
        break
      // refund.pending / refund.processing: nothing to do — the money has not
      // moved yet and the order only changes on refund.processed.
      case 'charge.dispute.create':
      case 'charge.dispute.resolve':
        await handleDispute(supabase, event.event, event.data)
        break
      case 'charge.dispute.remind':
        await handleDisputeReminder(supabase, event.data)
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
    .select('id, user_id, payment_status, amount_usd, gb_amount, paystack_reference, bandwidth_credited, is_canary, pay_currency, pay_amount')
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
    // verify-payment / reconcile often credit first; the card still has to be saved.
    if (!paymentMismatchReason({ amount, currency, reference }, order)) await captureSavedCardIfRequested(supabase, order, metadata, data)
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
    // Once per order: Paystack redelivers, and verify / reconcile look at the same
    // order again, none of which changes the outcome.
    await alertMismatchOnce(supabase, order.id, 'Payment does not match its order — NOT credited', {
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

  await captureSavedCardIfRequested(supabase, order, metadata, data)

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

// NOTE: Paystack documents no `charge.failed` event, so this handler may never
// fire; declines are also discovered by /api/verify-payment and the reconcile
// cron through the same failPendingOrder() helper. It is kept (harmless) in case
// an integration or a future Paystack release does send it.
async function handleChargeFailed(supabase: Admin, data: any) {
  const reference = data?.reference ?? ''
  const gateway_response = data?.gateway_response
  // Same validation as handleChargeSuccess: a non-UUID order_id used to reach
  // .eq('id', …), Postgres rejected it, we threw, and Paystack redelivered
  // the malformed event forever. Fall back to the unique reference.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const metaOrderId = data?.metadata?.order_id
  const order_id: string = typeof metaOrderId === 'string' && UUID_RE.test(metaOrderId) ? metaOrderId : ''

  let orderQuery = supabase.from('orders').select('id, payment_status, amount_usd, gb_amount, user_id, is_canary, pay_currency, pay_amount, paystack_reference')
  const lookup = order_id ? orderQuery.eq('id', order_id) : (reference ? orderQuery.eq('paystack_reference', reference) : null)
  const { data: order, error } = lookup ? await lookup.maybeSingle() : { data: null, error: null }
  if (error) throw error

  // A decline on one attempt is not final: the customer can retry another
  // card on the same Paystack session, and a later charge.success is still
  // credited (see handleChargeSuccess). Marking it 'failed' here is purely
  // informational. The customer is told once, on the pending → failed
  // transition (Paystack can deliver the same decline more than once).
  let transitioned = false
  if (order && order.payment_status === 'pending') {
    transitioned = await failPendingOrder(supabase, order, gateway_response ?? null, { source: 'webhook charge.failed' })
  }

  // The helper already alerts the admin about a failed canary.
  if (order?.is_canary && transitioned) return

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
  // Paystack's own id for the refund is the idempotency key. If a payload ever
  // carries neither refund_reference nor id, fall back to transaction + amount +
  // whatever timestamp it has — transaction + amount alone makes two genuine
  // partial refunds of the same size look like one redelivery, and the second
  // was dropped as a "duplicate" after the money had gone back to the customer.
  const explicitRef = data?.refund_reference ?? data?.id
  const usedFallback = explicitRef == null || explicitRef === ''
  const stamp: string = String(data?.refunded_at ?? data?.updated_at ?? data?.updatedAt ?? data?.created_at ?? data?.createdAt ?? '')
  const refundRef: string = usedFallback ? `${txRef}_${refundCents}${stamp ? `_${stamp}` : ''}` : String(explicitRef)

  if (!txRef || !Number.isFinite(refundCents) || refundCents <= 0) {
    await alertAdminPayment('refund.processed with an unreadable payload — handle manually', {
      transaction_reference: txRef || '(missing)', amount: data?.amount, refund_reference: refundRef,
    })
    return
  }

  const { data: order, error } = await supabase
    .from('orders').select('id, user_id, amount_usd, gb_amount, is_canary, pay_currency, pay_amount, refunded_usd').eq('paystack_reference', txRef).maybeSingle()
  if (error) throw error
  if (!order) {
    await alertAdminPayment('Refund processed for an unknown order', { transaction_reference: txRef, refund_reference: refundRef })
    return
  }

  // Refunds arrive in the currency the customer paid in. apply_order_refund
  // works in USD (the invoice currency), so an M-Pesa (KES) refund is converted
  // by the order's OWN locked ratio — never today's FX rate — which makes a full
  // KES refund exactly the full USD price and keeps partials proportional.
  const paidCur = String(order.pay_currency ?? 'USD').toUpperCase()
  const refundCur = data?.currency ? String(data.currency).toUpperCase() : paidCur
  if (refundCur !== paidCur) {
    await alertAdminPayment('Refund in an unexpected currency — handle manually', {
      order_id: order.id, refund_reference: refundRef, order_currency: paidCur, refund_currency: refundCur, amount: data?.amount,
    })
    return
  }
  let refundUsd = refundCents / 100
  if (paidCur !== 'USD') {
    const paidMajor = Number(order.pay_amount)
    if (!(paidMajor > 0)) {
      await alertAdminPayment('Refund on a non-USD order with no recorded charge amount — handle manually', { order_id: order.id, refund_reference: refundRef })
      return
    }
    const refundMajor = refundCents / 100
    // What is still refundable, in the customer's currency, going by what has
    // already been refunded in USD. Each partial refund is converted and rounded
    // to cents on its own, so converting every one proportionally could leave a
    // cent or two "un-refunded" on an order whose shillings have all come back
    // (and so never reach 'refunded'). A refund that clears everything left —
    // within rounding — takes exactly the remaining USD instead.
    const amountUsd = Number(order.amount_usd)
    const alreadyUsd = Number(order.refunded_usd ?? 0)
    const remainingUsd = Math.max(Math.round((amountUsd - alreadyUsd) * 100) / 100, 0)
    const remainingMajor = amountUsd > 0 ? paidMajor * (remainingUsd / amountUsd) : 0
    // Tolerance: one whole shilling plus two cents' worth of KES — each earlier
    // partial was rounded to a cent, so the leftover can drift by a cent or two.
    const tolMajor = 1 + (amountUsd > 0 ? (paidMajor / amountUsd) * 0.02 : 0)
    refundUsd = refundMajor >= remainingMajor - tolMajor
      ? remainingUsd
      : Math.round((refundMajor / paidMajor) * amountUsd * 100) / 100
  }

  // The affiliate commission behind this order, as it is BEFORE the refund
  // trigger reshapes it — so the affiliate can be told what changed.
  const commissionBefore = order.is_canary ? null : await snapshotCommission(supabase, order.id).catch(() => null)

  const { data: result, error: rpcErr } = await supabase.rpc('apply_order_refund', {
    p_order_id: order.id,
    p_refund_reference: refundRef,
    p_refund_usd: refundUsd,
    // What actually went back to the customer, in the currency they paid in, so
    // the credit note of an M-Pesa refund can state the shillings.
    ...(paidCur !== 'USD' ? { p_charged_amount: refundCents / 100, p_charged_currency: paidCur } : {}),
  })
  if (rpcErr) throw rpcErr

  if (result?.applied) {
    await alertAdminPayment(result.credited === false ? 'Refund recorded before the payment was credited' : 'Refund applied', {
      order_id: order.id, refund_usd: result.refund_usd, credit_note: result.credit_note,
      gb_clawed_back: result.gb_clawed, gb_not_recoverable: result.gb_shortfall, fully_refunded: result.fully_refunded,
      note: result.credited === false
        ? 'The charge.success had not been processed yet. The order will not be credited in full (a fully refunded order is never credited).'
        : 'If this order came through a referral/affiliate its commission is reduced automatically; a commission already PAID out is recorded as a clawback that the next payout cycle nets against the affiliate\'s new commissions (see Admin → Affiliates). GB not recoverable was already allocated to a session.',
    })
    if (!order.is_canary) {
      await notifyCommissionRefunded(supabase, order.id, commissionBefore)
      await sendRefundEmail(supabase, order.user_id, {
        refundUsd: Number(result.refund_usd), creditNote: result.credit_note ?? null,
        gbClawed: Number(result.gb_clawed ?? 0), credited: result.credited !== false, fullyRefunded: !!result.fully_refunded,
        local: paidCur !== 'USD' ? { currency: paidCur, amount: refundCents / 100 } : null,
      })
      // Customers with a webhook endpoint (resellers' billing automations) are
      // told too — a clawback used to be visible only by polling the balance.
      // Awaited, never throws; a canary order never reaches customers.
      await dispatchWebhook(order.user_id, 'bandwidth_refunded', {
        order_id: order.id, refund_usd: Number(result.refund_usd),
        gb_clawed_back: Number(result.gb_clawed ?? 0), gb_not_recoverable: Number(result.gb_shortfall ?? 0),
        fully_refunded: !!result.fully_refunded,
      })
    }
  } else if (result?.reason === 'duplicate') {
    if (usedFallback && !stamp) {
      // Nothing in the payload tells a redelivery from a second refund of the
      // same amount; say so rather than silently dropping a possible real one.
      await alertAdminPayment('Refund event ignored as a possible duplicate — please check', {
        order_id: order.id, refund_reference: refundRef, amount: data?.amount, currency: data?.currency ?? '',
        note: 'The payload had no refund id or timestamp. If this was a second refund of the same amount, apply it by hand (Admin → Orders / Adjust bandwidth).',
      })
    }
  } else {
    await alertAdminPayment('Refund could not be applied automatically', {
      order_id: order.id, refund_reference: refundRef, reason: result?.reason ?? 'unknown',
    })
  }
}

// refund.failed: Paystack could not return the money — the customer has NOT been
// refunded and nothing changed locally (the order only moves on
// refund.processed). refund.needs-attention: the processor needs the customer's
// details to complete it (typical for M-Pesa / mobile money); Paystack's
// "retry with customer details" step has to be done by a human. Both need a
// person, so both alert the admin. A failed refund also releases the admin
// refund lock so it can be sent again.
async function handleRefundProblem(supabase: Admin, kind: string, data: any) {
  const txRef: string = data?.transaction_reference ?? data?.transaction?.reference ?? ''
  const refundRef: string = String(data?.refund_reference ?? data?.id ?? '')
  const failed = kind === 'refund.failed'

  let orderId = ''
  if (txRef) {
    const { data: order, error } = await supabase
      .from('orders').select('id').eq('paystack_reference', txRef).maybeSingle()
    if (error) throw error // transient — let Paystack redeliver
    orderId = order?.id ?? ''
    if (failed && orderId) {
      const { error: relErr } = await supabase.from('orders').update({ refund_requested_at: null }).eq('id', orderId)
      if (relErr) throw relErr
    }
  }

  await alertAdminPayment(
    failed ? 'REFUND FAILED — the customer has not been refunded' : 'Refund needs attention — complete it in Paystack',
    {
      order_id: orderId || '(no matching order)',
      transaction_reference: txRef || '(missing)',
      refund_reference: refundRef || '(missing)',
      amount: data?.amount ?? '', currency: data?.currency ?? '',
      status: data?.status ?? '',
      note: failed
        ? 'Nothing was changed on the order. Check the refund in Paystack; the refund can be requested again from Admin → Orders.'
        : 'Open the refund in the Paystack dashboard and retry it with the customer’s details (mobile-money refunds often need this). The order updates automatically once Paystack reports it processed.',
    },
  )
}

// Disputes can be won, so nothing is clawed back when one OPENS. What IS
// automatic then: the order is flagged (orders.dispute_status) and the account
// cannot start new purchases while a dispute is open — otherwise buy → use →
// charge back could be repeated indefinitely. The admin is told immediately
// because Paystack's response window is short.
//
// When it RESOLVES: a resolution the merchant accepted (including the one
// Paystack applies itself when the response window lapses) means the money has
// been taken back from our balance — and Paystack sends no refund.processed for
// that, so the customer kept every GB. That case now takes the proportional
// bandwidth back and issues a credit note (lib/disputes.ts), exactly as a refund
// does. Any other resolution is recorded as 'resolved' without a guess about who
// won; the admin settles it with the "Dispute lost" / "Dispute won" buttons on
// Admin → Orders.
async function handleDispute(supabase: Admin, kind: string, data: any) {
  const txRef: string = data?.transaction?.reference ?? data?.transaction_reference ?? ''
  const opened = kind === 'charge.dispute.create'
  const resolution = data?.resolution ?? data?.status ?? null
  const accepted = !opened && /accept/i.test(String(data?.resolution ?? ''))

  let flagged = false
  let settledBefore: string | null = null
  let lost: { applied: boolean; refundUsd: number; gbClawed: number; gbNotRecoverable: number } | null = null
  if (txRef) {
    const { data: cur, error: curErr } = await supabase.from('orders')
      .select('id, user_id, amount_usd, gb_amount, refunded_usd, is_canary, bandwidth_credited, dispute_status, pay_currency, pay_amount')
      .eq('paystack_reference', txRef).maybeSingle()
    if (curErr) throw curErr // transient — let Paystack redeliver
    if (cur) {
      flagged = true
      if (cur.dispute_status === 'lost' || cur.dispute_status === 'won' || (opened && (cur.dispute_status === 'resolved' || cur.dispute_status === 'open'))) {
        // An admin already settled it (or an earlier delivery of this event did):
        // never overwrite a decided outcome with a plain 'resolved', and never let a
        // duplicate 'create' re-stamp dispute_opened_at on a dispute that is already open
        // (the admin reads that date to judge how much of Paystack's response window is left).
        settledBefore = cur.dispute_status
      } else {
        const patch = opened
          ? { dispute_status: 'open', dispute_opened_at: new Date().toISOString(), dispute_resolution: null }
          : { dispute_status: 'resolved', dispute_resolution: String(resolution ?? 'resolved').slice(0, 200) }
        // Conditional on the status just read: an admin pressing "Dispute lost" / "won" between
        // the read and this write must not be turned back into a plain 'resolved'.
        let upd = supabase.from('orders').update(patch).eq('id', cur.id)
        upd = cur.dispute_status == null ? upd.is('dispute_status', null) : upd.eq('dispute_status', cur.dispute_status)
        const { data: written, error } = await upd.select('id')
        if (error) throw error // transient — let Paystack redeliver
        if ((written?.length ?? 0) === 0) {
          // Changed under us: leave the newer outcome alone and let the alert say so.
          settledBefore = 'changed meanwhile'
        } else {
        // Tell the customer why purchases just paused — once, on the transition (a
        // redelivered create finds it already open).
        if (opened && cur.dispute_status !== 'open' && !cur.is_canary) {
          await sendDisputeOpenedEmail(supabase, cur.user_id, { amountUsd: Number(cur.amount_usd), gb: Number(cur.gb_amount) })
        }
        if (accepted && cur.bandwidth_credited) {
          // A partial chargeback takes only its share: convert refund_amount (minor
          // units of the charged currency) with the order's own locked ratio.
          let partialUsd: number | undefined
          let unconvertible = false
          const disputed = Number(data?.refund_amount)
          if (Number.isFinite(disputed) && disputed > 0) {
            const orderUsd = Number(cur.amount_usd)
            const paidCur = String(cur.pay_currency ?? 'USD').toUpperCase()
            const major = disputed / 100
            let usd: number | null = null
            if (paidCur === 'USD') usd = major
            else if (Number(cur.pay_amount) > 0) usd = orderUsd * (major / Number(cur.pay_amount))
            if (usd == null || !Number.isFinite(usd)) unconvertible = true
            else if (usd < orderUsd - 0.005) partialUsd = Math.round(usd * 100) / 100
          }
          if (unconvertible) {
            await alertAdminPayment('Dispute accepted with a partial amount that could not be converted — use "Dispute lost" with an amount', {
              order_id: cur.id, transaction_reference: txRef, refund_amount: data?.refund_amount,
            })
          } else {
            const r = await applyDisputeLoss(supabase, cur, { source: 'webhook charge.dispute.resolve', resolution: String(resolution ?? 'merchant-accepted'), amountUsd: partialUsd })
            lost = { applied: r.applied, refundUsd: r.refundUsd, gbClawed: r.gbClawed, gbNotRecoverable: r.gbNotRecoverable }
          }
        }
        }
      }
    }
  }

  await alertAdminPayment(opened ? 'DISPUTE OPENED — respond in Paystack' : 'Dispute resolved', {
    transaction_reference: txRef || '(unknown)',
    status: data?.status ?? '', resolution: data?.resolution ?? '', refund_amount: data?.refund_amount ?? '',
    category: data?.category ?? '',
    order_flagged: flagged ? (opened ? 'yes — new purchases paused for this account' : 'yes — purchase pause lifted') : 'no matching order found',
    ...(opened ? {} : {
      outcome: settledBefore ? `already settled as "${settledBefore}" — left unchanged` : lost
        ? (lost.applied ? `LOST — ${lost.gbClawed} GB taken back, $${lost.refundUsd.toFixed(2)} credited back on the order` : 'LOST — nothing left on the order to take back')
        : 'Not stated as lost — if it was lost, use "Dispute lost" on Admin → Orders',
    }),
  })
}

// charge.dispute.remind: Paystack repeats it every 4 hours while a dispute is unanswered, and
// the response window is short. The admin was told once when it opened; this nags — but at
// most every 12 hours per order (a conditional write, so overlapping deliveries send one).
async function handleDisputeReminder(supabase: Admin, data: any) {
  const txRef: string = data?.transaction?.reference ?? data?.transaction_reference ?? ''
  if (!txRef) return
  const { data: order, error } = await supabase.from('orders')
    .select('id, amount_usd, is_canary, dispute_status').eq('paystack_reference', txRef).maybeSingle()
  if (error) throw error
  if (!order || order.dispute_status !== 'open') return // answered / settled / not ours
  const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString()
  const { data: stamped, error: stErr } = await supabase.from('orders')
    .update({ dispute_reminded_at: new Date().toISOString() })
    .eq('id', order.id).eq('dispute_status', 'open').or(`dispute_reminded_at.is.null,dispute_reminded_at.lt.${cutoff}`).select('id')
  if (stErr) throw stErr
  if ((stamped?.length ?? 0) === 0) return
  await alertAdminPayment('DISPUTE STILL UNANSWERED — respond in Paystack', {
    order_id: order.id, transaction_reference: txRef, amount_usd: Number(order.amount_usd),
    note: 'Paystack is reminding you: the response window for this chargeback is running out. After it lapses Paystack accepts the dispute on your behalf.',
  })
}
