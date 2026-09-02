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

export async function verifyTransaction(reference: string) {
  const res = await fetch(`${BASE}/transaction/verify/${reference}`, {
    headers: { 'Authorization': `Bearer ${SECRET}` },
  })
  const data = await res.json()
  if (!data.status) throw new Error(data.message ?? 'Verification failed')
  return data.data as {
    status: string
    reference: string
    amount: number
    metadata: Record<string, string>
  }
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
// what the order expects. Neither the webhook nor verify-payment checked
// this before — both trusted `status === 'success'` plus whatever gb_amount
// was in metadata, with nothing tying the two together.
export function amountMatchesOrder(paidAmountCents: number, orderAmountUsd: number): boolean {
  return paidAmountCents === Math.round(orderAmountUsd * 100)
}

export function generateReference(): string {
  const crypto = require('crypto')
  return `gp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
}