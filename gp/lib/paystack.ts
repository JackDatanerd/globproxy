const SECRET = process.env.PAYSTACK_SECRET_KEY!
const BASE = 'https://api.paystack.co'

export async function initializeTransaction(params: {
  email: string
  amount_usd: number
  reference: string
  metadata: Record<string, string>
  callback_url: string
  // M-Pesa: charge `amount_major` in `currency` (whole KES) and restrict the
  // checkout to the mobile-money channel. Omitted = the original USD card flow.
  currency?: 'USD' | 'KES'
  amount_major?: number
  channels?: string[]
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
      amount: Math.round((params.amount_major ?? params.amount_usd) * 100), // minor units (cents)
      currency: params.currency ?? 'USD',
      ...(params.channels ? { channels: params.channels } : {}),
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
  gateway_response?: string
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

// Paystack answered and said no (a 4xx with status:false — invalid authorization, bad
// request). Nothing was charged, so the caller may treat it as a decline.
export class ChargeRejectedError extends Error {}

// We cannot tell whether the card was charged: the request timed out, the connection
// dropped, Paystack answered 5xx / 429 or with something that is not JSON. The charge may
// well have gone through, so the caller must NOT call it a decline — it leaves the order
// pending and lets the webhook / reconcile cron settle it by reference.
export class ChargeOutcomeUnknownError extends Error {}

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
  let res: Response
  try {
    res = await fetch(`${BASE}/transaction/charge_authorization`, {
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
  } catch (e: any) {
    throw new ChargeOutcomeUnknownError(`No answer from Paystack: ${e?.message ?? e}`)
  }
  if (res.status >= 500 || res.status === 429) {
    throw new ChargeOutcomeUnknownError(`Paystack answered ${res.status}`)
  }
  let data: any
  try {
    data = await res.json()
  } catch {
    throw new ChargeOutcomeUnknownError(`Paystack answered ${res.status} with an unreadable body`)
  }
  if (!data || typeof data !== 'object') throw new ChargeOutcomeUnknownError('Paystack answered with an empty body')
  if (!data.status) throw new ChargeRejectedError(data.message ?? 'Charge authorization failed')
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

// What Paystack should have charged for an order, in its own currency and
// minor units. USD card orders: amount_usd. M-Pesa orders: the KES amount that
// was locked onto the order at checkout (pay_amount), because that — not the
// USD price — is what the customer was actually asked to pay.
export function expectedCharge(order: {
  amount_usd: number | string
  pay_currency?: string | null
  pay_amount?: number | string | null
}): { currency: string; minor: number } {
  const cur = String(order.pay_currency ?? 'USD').toUpperCase()
  if (cur !== 'USD' && order.pay_amount != null) {
    return { currency: cur, minor: Math.round(Number(order.pay_amount) * 100) }
  }
  return { currency: 'USD', minor: Math.round(Number(order.amount_usd) * 100) }
}

// Returns true if the amount Paystack actually charged (in minor units) matches
// what the order expects.
export function amountMatchesOrder(paidMinor: number, order: Parameters<typeof expectedCharge>[0]): boolean {
  return Number(paidMinor) === expectedCharge(order).minor
}

// Single source of truth for "does this Paystack payment actually pay for
// this order?" — shared by the webhook, /api/verify-payment and the
// reconcile cron so the three can't drift. Returns null when everything
// lines up, otherwise a short human-readable reason. Currency is only
// rejected when Paystack states one and it isn't the order's (USD for cards,
// KES for M-Pesa); a missing field is not treated as a mismatch so a
// payload-shape quirk can never strand a genuine payment.
export function paymentMismatchReason(
  paid: { amount: number; currency?: string | null; reference?: string | null },
  order: {
    amount_usd: number | string
    paystack_reference: string | null
    pay_currency?: string | null
    pay_amount?: number | string | null
  },
): string | null {
  const exp = expectedCharge(order)
  if (paid.currency && String(paid.currency).toUpperCase() !== exp.currency) {
    return `currency ${paid.currency} (expected ${exp.currency})`
  }
  if (Number(paid.amount) !== exp.minor) {
    return `amount ${paid.amount} minor units (expected ${exp.minor} ${exp.currency})`
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
// Starts a refund on a settled transaction. The money movement and the
// bandwidth claw-back are NOT done here: Paystack answers "pending", and the
// refund.processed webhook (app/api/webhooks/paystack) is what credits the
// customer's refund, takes the GB back and issues the credit note — exactly
// the path a refund made from the Paystack dashboard takes, so there is a
// single place that decides what a refund does. Omit `amount_major` for the
// full remaining amount. `amount_major` is in the transaction's OWN currency
// (USD for card orders, KES for M-Pesa orders), in major units.
export class RefundOutcomeUnknownError extends Error {
  constructor(message: string) { super(message); this.name = 'RefundOutcomeUnknownError' }
}

export async function createRefund(params: { reference: string; amount_major?: number; currency?: string; merchant_note?: string }) {
  const body: Record<string, unknown> = { transaction: params.reference }
  if (params.amount_major != null) {
    body.amount = Math.round(params.amount_major * 100) // minor units
    body.currency = (params.currency ?? 'USD').toUpperCase()
  }
  if (params.merchant_note) body.merchant_note = params.merchant_note.slice(0, 200)

  // A timeout, a dropped connection or a 5xx does NOT tell us whether Paystack
  // accepted the refund — it may have, and only the response was lost. Those are
  // reported as RefundOutcomeUnknownError so the caller leaves the in-flight claim
  // in place (a retry could otherwise refund the customer twice). Only a clear
  // 4xx rejection from Paystack is a definite "nothing was started".
  let res: Response
  try {
    res = await fetch(`${BASE}/refund`, {
      signal: AbortSignal.timeout(20000),
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (e: any) {
    throw new RefundOutcomeUnknownError(`No answer from Paystack (${e?.name ?? 'network error'}); the refund may or may not have started.`)
  }
  const data = await res.json().catch(() => null)
  if (res.status >= 500 || data == null) {
    throw new RefundOutcomeUnknownError(`Paystack returned an unusable answer (HTTP ${res.status}); the refund may or may not have started.`)
  }
  if (!data?.status) throw new Error(data?.message ?? 'Paystack refund request failed')
  return data.data as { status?: string; amount?: number; transaction?: { reference?: string } }
}
