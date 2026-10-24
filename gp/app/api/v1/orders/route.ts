import { withApiAuth, parsePage, parseDateParam, readJsonBody, asApiRateLimited } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { runIdempotent } from '@/lib/idempotency'
import { resolveOrder, CUSTOM_MIN_GB, CUSTOM_MAX_GB } from '@/lib/plans'
import { startCheckout, purchaseBlock } from '@/lib/checkout'
import { rateLimited, rateLimitedUser } from '@/lib/rateLimit'
import { NextResponse } from 'next/server'

// POST /api/v1/orders   { "plan": "growth" }  or  { "plan": "custom", "gb": 37 }
// Starts a bandwidth purchase and returns a hosted card-checkout link. Nothing is
// charged until a person pays on that page; the bandwidth is credited the moment the
// payment is confirmed (a `bandwidth_credited` webhook with source "purchase", and the
// order turns "paid" in GET /orders/:id). Prices: GET /api/v1/pricing. Card only —
// M-Pesa needs the buyer to confirm a live exchange rate, so it stays in the dashboard.
// Starting a new checkout retires the account's other unpaid orders (same as the buy
// page). `Idempotency-Key` is optional: a retry returns the same order and link.
// Needs the `write` scope.
export async function POST(req: Request) {
  return withApiAuth(req, 'POST orders', async ({ user, supabase }) => {
    const json = await readJsonBody(req)
    if (!json.ok) return json.response
    const b = json.body
    if (!b || typeof b !== 'object' || Array.isArray(b)) return apiError(400, 'invalid_request', 'Body must be a JSON object like { "plan": "growth" } or { "plan": "custom", "gb": 37 }.')
    if (b.method !== undefined && b.method !== 'card') {
      return apiError(400, 'invalid_request', 'Only card checkout is available through the API. Pay by M-Pesa from the dashboard.')
    }
    const quote = resolveOrder(b.plan, b.gb)
    if (!quote) {
      return apiError(400, 'invalid_request', `plan must be one of micro, starter, growth, scale — or "custom" with gb as a whole number from ${CUSTOM_MIN_GB} to ${CUSTOM_MAX_GB}.`)
    }

    // The same payment limiter the buy page uses, per address and per account.
    const limited = (await rateLimited(req, 'PAYMENT_RATE_LIMITER', user.id)) ?? (await rateLimitedUser('PAYMENT_RATE_LIMITER', user.id, 'checkout'))
    if (limited) return asApiRateLimited(limited)

    const { data: profile } = await supabase.from('profiles').select('email').eq('id', user.id).maybeSingle()
    if (!profile?.email) return apiError(400, 'invalid_request', 'Your account has no email address. Add one in the dashboard before purchasing.')
    const blocked = await purchaseBlock(supabase, user.id)
    if (blocked) return apiError(403, 'forbidden', blocked)

    return runIdempotent(req, supabase, user.id, 'POST /orders', JSON.stringify([quote.slug, quote.gb]), async () => {
      try {
        const started = await startCheckout(supabase, { id: user.id, email: profile.email }, quote)
        return {
          kind: 'ok', status: 201,
          body: {
            order: { id: started.order.id, gb_amount: quote.gb, amount_usd: quote.total, status: 'pending', created_at: started.order.created_at },
            checkout_url: started.url,
          },
        }
      } catch (e) {
        console.error('[v1 POST orders] checkout start failed', e)
        return { kind: 'fail', response: apiError(503, 'service_unavailable', 'Could not start checkout. Try again shortly.') }
      }
    })
  }, { scope: 'write' })
}

// GET /api/v1/orders?limit=50&offset=0&status=paid&created_after=…&created_before=…
// Bandwidth purchases (read-only). Payment-processor references are
// deliberately not exposed.
export async function GET(req: Request) {
  return withApiAuth(req, 'GET orders', async ({ user, supabase }) => {
    const url = new URL(req.url)
    const { limit, offset } = parsePage(url, { limit: 50, max: 200 })
    const status = url.searchParams.get('status')
    if (status && !['pending', 'paid', 'failed', 'refunded', 'cancelled'].includes(status)) {
      return apiError(400, 'invalid_request', 'status must be one of: pending, paid, failed, refunded, cancelled.')
    }

    const after = parseDateParam(url, 'created_after')
    const before = parseDateParam(url, 'created_before')
    if (after === undefined || before === undefined) return apiError(400, 'invalid_request', 'created_after / created_before must be ISO 8601 timestamps.')

    let q = supabase
      .from('orders')
      .select('id, gb_amount, amount_usd, payment_status, invoice_number, refunded_usd, refunded_at, created_at, paid_at', { count: 'exact' })
      .eq('user_id', user.id)
      .eq('is_canary', false)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1)
    if (status) q = q.eq('payment_status', status)
    if (after) q = q.gte('created_at', after)
    if (before) q = q.lt('created_at', before)

    const { data, count, error } = await q
    if (error) {
      console.error('[v1 GET orders] query failed', error)
      return apiError(500, 'internal_error', 'Internal error. Please try again.')
    }
    const total = count ?? (data?.length ?? 0)
    return NextResponse.json({
      orders: (data ?? []).map((o) => ({
        id: o.id, gb_amount: Number(o.gb_amount), amount_usd: Number(o.amount_usd), status: o.payment_status,
        invoice_number: o.invoice_number, refunded_usd: Number(o.refunded_usd ?? 0), refunded_at: o.refunded_at,
        created_at: o.created_at, paid_at: o.paid_at,
      })),
      total, limit, offset, has_more: offset + (data?.length ?? 0) < total,
    })
  })
}
