const SECRET = process.env.PAYSTACK_SECRET_KEY!
const BASE = 'https://api.paystack.co'

export async function initializeTransaction(params: {
  email: string
  amount_usd: number
  reference: string
  metadata: Record<string, string>
  callback_url: string
}) {
  const amount_kobo = Math.round(params.amount_usd * 100 * 1550) // USD → KES (approx) → kobo, or use USD directly
  // Paystack supports USD natively with currency param
  const res = await fetch(`${BASE}/transaction/initialize`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: params.email,
      amount: Math.round(params.amount_usd * 100), // in cents (USD)
      currency: 'USD',
      reference: params.reference,
      callback_url: params.callback_url,
      metadata: { custom_fields: Object.entries(params.metadata).map(([k, v]) => ({ display_name: k, variable_name: k, value: v })) },
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
    status: string // 'success' | 'failed' | 'pending'
    reference: string
    amount: number
    metadata: { custom_fields: Array<{ variable_name: string; value: string }> }
  }
}

export function verifyWebhookSignature(body: string, signature: string): boolean {
  const crypto = require('crypto')
  const hash = crypto.createHmac('sha512', process.env.PAYSTACK_WEBHOOK_SECRET!).update(body).digest('hex')
  return hash === signature
}

export function generateReference(): string {
  return `gp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}
