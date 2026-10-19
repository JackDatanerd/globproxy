const SECRET = process.env.PAYSTACK_SECRET_KEY!
const BASE = 'https://api.paystack.co'

export async function initializeTransaction(params: {
  email: string
  amount_usd: number
  reference: string
  metadata: Record<string, string>
  callback_url: string
}) {
  const res = await fetch(`${BASE}/transaction/initialize`, {
    signal: AbortSignal.timeout(15000), // a hung Paystack call must not pin the Worker request
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: params.email,
      amount: Math.round(params.amount_usd * 100), // cents (USD)
      currency: 'USD',
      reference: params.reference,
      callback_url: params.callback_url,
      metadata: params.metadata, // flat object — matches how webhook reads it
    }),
  })
  const data = await res.json()
  if (!data.status) throw new Error(data.message ?? 'Paystack initialization failed')
  return data.data as { authorization_url: string; reference: string; access_code: string }
}

export interface PaystackTransaction {
  status: string
  reference: string
  amount: number
  currency?: string
  metadata: Record<string, string>
}

export async function verifyTransaction(reference: string): Promise<PaystackTransaction> {
  const res = await fetch(`${BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { 'Authorization': `Bearer ${SECRET}` },
    signal: AbortSignal.timeout(10000), // reconcile loops over several of these per run
  })
  const data = await res.json()
  if (!data.status) throw new Error(data.message ?? 'Verification failed')
  return data.data as PaystackTransaction
}

// Charges a previously-saved card via its Paystack authorization_code —
// no checkout page, no human re-entering card details. Powers the
// 'canary' cron task (app/api/cron/[task]/route.ts): once the canary
// account has made one normal checkout, the webhook stores the
// authorization_code it comes back with (see webhooks/paystack/route.ts),
// and every canary run afterward reuses it to charge a small real amount
// end-to-end. Same reference/metadata shape as initializeTransaction so
// the existing webhook charge.success/charge.failed handling covers this
// path unchanged.
export async function chargeAuthorization(params: {
  email: string
  amount_usd: number
  reference: string
  authorization_code: string
  metadata: Record<string, string>
}) {
  const res = await fetch(`${BASE}/transaction/charge_authorization`, {
    signal: AbortSignal.timeout(20000),
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: params.email,
      amount: Math.round(params.amount_usd * 100),
      currency: 'USD',
      reference: params.reference,
      authorization_code: params.authorization_code,
      metadata: params.metadata,
    }),
  })
  const data = await res.json()
  if (!data.status) throw new Error(data.message ?? 'Charge authorization failed')
  return data.data as { status: string; reference: string; gateway_response?: string }
}

export function verifyWebhookSignature(body: string, signature: string): boolean {
  const crypto = require('crypto')
  // Paystack signs with your secret key — there is no separate webhook secret
  const hash = crypto.createHmac('sha512', SECRET).update(body).digest('hex')
  const a = Buffer.from(hash)
  const b = Buffer.from(signature)
  // Plain === leaks timing info proportional to how many leading bytes match.
  // Guard the length check first since timingSafeEqual throws on mismatched
  // lengths rather than returning false.
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

// Returns true if the amount Paystack actually charged (in cents) matches
// what the order expects.
export function amountMatchesOrder(paidAmountCents: number, orderAmountUsd: number): boolean {
  return Number(paidAmountCents) === Math.round(Number(orderAmountUsd) * 100)
}

// Single source of truth for "does this Paystack payment actually pay for
// this order?" — shared by the webhook, /api/verify-payment and the
// reconcile cron so the three can't drift. Returns null when everything
// lines up, otherwise a short human-readable reason. Currency is only
// rejected when Paystack states one and it isn't USD (checkout always
// initializes in USD); a missing field is not treated as a mismatch so a
// payload-shape quirk can never strand a genuine payment.
export function paymentMismatchReason(
  paid: { amount: number; currency?: string | null; reference?: string | null },
  order: { amount_usd: number | string; paystack_reference: string | null },
): string | null {
  if (paid.currency && String(paid.currency).toUpperCase() !== 'USD') {
    return `currency ${paid.currency} (expected USD)`
  }
  if (!amountMatchesOrder(paid.amount, Number(order.amount_usd))) {
    return `amount ${paid.amount} cents (expected ${Math.round(Number(order.amount_usd) * 100)})`
  }
  if (paid.reference && order.paystack_reference && paid.reference !== order.paystack_reference) {
    return `reference ${paid.reference} does not match the order's ${order.paystack_reference}`
  }
  return null
}

export function generateReference(): string {
  const crypto = require('crypto')
  return `gp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
}