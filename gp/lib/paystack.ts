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