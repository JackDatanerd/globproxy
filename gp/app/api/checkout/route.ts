import { requireMfaVerified } from '@/lib/mfa'
import { createAdminClient, createClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { startCheckout, purchaseBlock } from '@/lib/checkout'
import { resolveOrder } from '@/lib/plans'
import { applyPercent, publicPromo } from '@/lib/promo'
import { getKesQuote, kesFor } from '@/lib/fx'
import { isCrossSiteRequest } from '@/lib/appUrl'
import { rateLimited, rateLimitedUser } from '@/lib/rateLimit'
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
    // Per account as well: the line above is per address+user, which a caller
    // changing address gets around.
    const perUser = await rateLimitedUser('PAYMENT_RATE_LIMITER', caller.id, 'checkout')
    if (perUser) return perUser

    const user = { id: caller.id, email: caller.email }
    const supabase = await createAdminClient()

    const suspended = await requireActiveUser(user.id)
    if (suspended) return suspended

    // Buying is a money-moving action: an account with 2FA must have passed
    // the step-up in this browser (the cookie is sent whichever way the
    // caller authenticated).
    const mfaBlock = await requireMfaVerified(req, user.id)
    if (mfaBlock) return mfaBlock

    // A payment dispute is open on this account, or one was lost and the account is on
    // hold: no new purchases.
    const blocked = await purchaseBlock(supabase, user.id)
    if (blocked) return NextResponse.json({ error: blocked }, { status: 403 })

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
    // The M-Pesa offer, when one is live: the order is priced at the discounted total, so the KES
    // the customer is asked for, the amount Paystack verifies, the invoice, refunds and affiliate
    // commission all follow from the one figure stored as amount_usd.
    let priced = planData
    let promo: { listUsd: number; pct: number } | undefined
    if (method === 'mpesa') {
      const quote = await getKesQuote(supabase)
      if (!quote) {
        return NextResponse.json({ error: 'M-Pesa is temporarily unavailable. Please pay by card or try again later.' }, { status: 503 })
      }
      if (quote.promo) {
        priced = { ...planData, total: applyPercent(planData.total, quote.promo.percent) }
        promo = { listUsd: planData.total, pct: quote.promo.percent }
      }
      const amount = kesFor(priced.total, quote.rate)
      // The customer saw a KES price on the buy page. KES is charged in whole
      // shillings, so what they saw and what is charged must be the SAME number:
      // if the rate has refreshed since (or the caller did not say what it
      // displayed) make them re-confirm the amount rather than charging a figure
      // they did not see. This used to tolerate a 1% drift — up to 1% more or less
      // than the price on screen — and skipped the check when nothing was sent.
      // The same check covers the offer starting, changing or ending between the page
      // loading and the click: the answer carries the current offer so the page can say so.
      const expected = Number(body?.expected_kes)
      if (!Number.isFinite(expected) || expected <= 0 || amount !== Math.round(expected)) {
        return NextResponse.json({
          error: 'The price just updated. Please review the new amount and try again.',
          rate_changed: true, rate: quote.rate, amount_kes: amount, promo: publicPromo(quote.promo),
        }, { status: 409 })
      }
      kes = { amount, rate: quote.rate }
    }

    if (!user.email) {
      return NextResponse.json({ error: 'Your account has no email address. Add one before purchasing.' }, { status: 400 })
    }
    const started = await startCheckout(supabase, { id: user.id, email: user.email }, priced, kes, { saveCard: body?.save_card === true, promo })

    return NextResponse.json({
      url: started.url,
      access_code: started.access_code,
      reference: started.reference,
      ...(kes ? { amount_kes: kes.amount } : {}),
    })
  } catch (err: any) {
    console.error('Checkout error:', err)
    return NextResponse.json({ error: 'Could not start checkout. Please try again.' }, { status: 500 })
  }
}
