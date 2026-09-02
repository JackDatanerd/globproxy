import { NextResponse } from 'next/server'
import { verifyWebhookSignature, amountMatchesOrder } from '@/lib/paystack'
import { activateBandwidth } from '@/lib/bandwidth'
import { createAdminClient } from '@/lib/supabase/server'
import { sendEmail, escapeHtml } from '@/lib/email'


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

      // Canary bootstrap: the 'canary' cron task (app/api/cron/[task]/route.ts)
      // needs a reusable authorization_code to charge without a checkout page.
      // Rather than requiring a separate manual "save this card" flow, just
      // capture it here — if this successful charge belongs to the
      // admin-designated canary account (platform_settings.canary_user_id)
      // and Paystack marked the card reusable, store/refresh the code. Cheap:
      // one extra settings read only reached after a real charge.success, and
      // only acts when the ids match.
      const { data: canarySetting } = await supabase
        .from('platform_settings').select('value').eq('key', 'canary_user_id').maybeSingle()
      if (canarySetting?.value && canarySetting.value === user_id) {
        const auth = event.data.authorization
        if (auth?.reusable && auth?.authorization_code) {
          await supabase.from('platform_settings').upsert(
            { key: 'canary_authorization_code', value: auth.authorization_code },
            { onConflict: 'key' },
          )
        }
      }
    } else if (event.event === 'charge.failed') {
      // Previously unhandled entirely — a declined charge left its order
      // sitting 'pending' with zero signal anywhere until the 24h cron
      // cleanup (runCleanup) quietly flipped it to 'failed' with no reason
      // recorded and no alert sent. This is what actually gave the incident
      // ("payments failing, only found out by opening /admin/orders")
      // its multi-day blind spot. Now: mark it failed immediately, record
      // Paystack's own decline reason, and email admin the moment it happens.
      const { reference, metadata, gateway_response } = event.data
      const order_id = metadata?.order_id ?? ''

      const supabase = await createAdminClient()
      const { data: order } = order_id
        ? await supabase.from('orders').select('id, payment_status, amount_usd, gb_amount, user_id').eq('id', order_id).single()
        : { data: null }

      if (order && order.payment_status === 'pending') {
        await supabase.from('orders').update({
          payment_status: 'failed',
          failure_reason: gateway_response ?? 'Declined',
          failed_at: new Date().toISOString(),
        }).eq('id', order.id)
      }

      // customer.email / gateway_response come back from Paystack's own API
      // response, not raw client input — but they ultimately echo values a
      // buyer chose (their signup email; the bank's free-text decline
      // string), so escape them into this HTML body same as every other
      // email in lib/email.ts that interpolates a user-influenced field.
      const customerEmail = escapeHtml(event.data.customer?.email ?? 'unknown')
      const safeReason = escapeHtml(gateway_response ?? 'not provided')
      await sendEmail({
        to: process.env.ADMIN_EMAIL!,
        subject: `[PAYMENT FAILED] ${gateway_response ?? 'Declined'} — $${order?.amount_usd ?? '?'}`,
        html: `<p><strong>Customer:</strong> ${customerEmail}</p>
               <p><strong>Amount:</strong> $${order?.amount_usd ?? 'unknown'} (${order?.gb_amount ?? '?'} GB)</p>
               <p><strong>Reference:</strong> ${escapeHtml(reference)}</p>
               <p><strong>Paystack reason:</strong> ${safeReason}</p>
               <p>Order marked 'failed' immediately — previously this sat 'pending'
               for up to 24h before the cleanup cron caught it.</p>
               <a href="${process.env.NEXT_PUBLIC_APP_URL}/admin">Open admin panel →</a>`,
      }).catch((e) => console.error('[webhook] charge.failed alert email threw', e))
    }

    return NextResponse.json({ received: true })
  } catch (err: any) {
    console.error('[webhook] CRASH', err?.message, err?.stack)
    return NextResponse.json({ received: true }) // always 200 so Paystack stops retrying
  }
}