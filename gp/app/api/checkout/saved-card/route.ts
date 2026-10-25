import { createAdminClient, createClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { requireStepUp } from '@/lib/reauth'
import { purchaseBlock } from '@/lib/checkout'
import { resolveOrder } from '@/lib/plans'
import { isCrossSiteRequest } from '@/lib/appUrl'
import { rateLimitedUser } from '@/lib/rateLimit'
import { cardExpired, cardExpiresSoon, cardExpiryLabel } from '@/lib/rechargeRules'
import { payWithSavedCard } from '@/lib/savedCardPay'
import { parseIdempotencyKey, claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } from '@/lib/idempotency'
import { NextResponse } from 'next/server'

// One-click purchase with the card saved at an earlier checkout (Buy Bandwidth → "Pay with
// •••• 1234"). The card itself never reaches the browser — only brand, last four and expiry.
//
//   GET   → { card: { brand, last4, exp_month, exp_year, expired, expires_soon, valid_through } | null }
//   POST  { plan, gb? }  + header Idempotency-Key  →
//           200 { status: 'credited', reference }
//           202 { status: 'pending',  reference }   outcome not known yet — poll /api/verify-payment, never re-POST
//           402 { status: 'declined', error }
//           409 { status: 'needs_action' | 'card_expired', error }   pay through the normal checkout instead
//           404 { status: 'no_card' }
//
// Charging a stored card with one click is the most sensitive way to spend money here, so it
// takes the same step-up as deleting an account: 2FA accounts re-enter an authenticator code,
// the rest their password. The price is computed here, never taken from the client.

async function currentUser() {
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  return user
}

export async function GET() {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = await createAdminClient()
  const { data: card, error } = await admin.from('saved_cards')
    .select('brand, last4, exp_month, exp_year').eq('user_id', user.id).maybeSingle()
  if (error) {
    console.error('[saved-card] load failed', error)
    return NextResponse.json({ error: 'Could not load your saved card.' }, { status: 500 })
  }
  return NextResponse.json({
    card: card ? {
      ...card,
      expired: cardExpired(card.exp_month, card.exp_year),
      expires_soon: cardExpiresSoon(card.exp_month, card.exp_year),
      valid_through: cardExpiryLabel(card.exp_month, card.exp_year),
    } : null,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: Request) {
  try {
    const user = await currentUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (isCrossSiteRequest(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const limited = await rateLimitedUser('PAYMENT_RATE_LIMITER', user.id, 'saved-card')
    if (limited) return limited

    const suspended = await requireActiveUser(user.id)
    if (suspended) return suspended
    const gate = await requireStepUp(req, user.id)
    if (gate) return gate

    const admin = await createAdminClient()
    const blocked = await purchaseBlock(admin, user.id)
    if (blocked) return NextResponse.json({ error: blocked }, { status: 403 })

    const body = await req.json().catch(() => null)
    const quote = resolveOrder(body?.plan, body?.gb)
    if (!quote) return NextResponse.json({ error: 'Invalid plan' }, { status: 400 })

    // A double click, a retry after a dropped answer or two tabs must never charge twice.
    const idem = parseIdempotencyKey(req)
    if (!idem.ok) return NextResponse.json({ error: idem.error }, { status: 400 })
    if (!idem.key) return NextResponse.json({ error: 'An Idempotency-Key header is required.' }, { status: 400 })
    const claim = await claimIdempotencyKey(admin, user.id, idem.key, JSON.stringify({ plan: quote.slug, gb: quote.gb }), 'POST /checkout/saved-card', { allowStaleTakeover: false })
    if (claim.kind === 'replay') return NextResponse.json(claim.body ?? {}, { status: claim.status })
    if (claim.kind === 'mismatch') return NextResponse.json({ error: 'This request was already made with different values. Reload the page and try again.' }, { status: 422 })
    if (claim.kind === 'in_flight') return NextResponse.json({ status: 'pending', error: 'This payment is still being processed. Check Billing in a moment.' }, { status: 409 })
    if (claim.kind === 'unknown_outcome') return NextResponse.json({ status: 'pending', error: 'An earlier attempt did not finish. Check Billing before paying again.' }, { status: 409 })

    let status = 500
    let out: Record<string, unknown> = { error: 'Could not take the payment. Please try again.' }
    let keep = false // only outcomes worth replaying keep the key
    try {
      const r = await payWithSavedCard(admin, { id: user.id }, quote)
      switch (r.outcome) {
        case 'credited': status = 200; out = { status: 'credited', reference: r.reference }; keep = true; break
        case 'pending': status = 202; out = { status: 'pending', reference: r.reference }; keep = true; break
        case 'declined': status = 402; out = { status: 'declined', error: r.reason }; break
        case 'needs_action': status = 409; out = { status: 'needs_action', error: 'Your bank wants extra verification for this card. Use the card checkout instead.' }; break
        case 'card_expired': status = 409; out = { status: 'card_expired', error: 'Your saved card has expired. Use the card checkout to pay and save a new one.' }; break
        case 'no_card': status = 404; out = { status: 'no_card', error: 'No saved card found.' }; break
      }
    } catch (e) {
      console.error('[saved-card] payment failed', e)
    }
    if (keep) await completeIdempotencyKey(admin, user.id, idem.key, status, out)
    else await releaseIdempotencyKey(admin, user.id, idem.key)
    return NextResponse.json(out, { status })
  } catch (e) {
    console.error('[saved-card] error', e)
    return NextResponse.json({ error: 'Could not take the payment. Please try again.' }, { status: 500 })
  }
}
