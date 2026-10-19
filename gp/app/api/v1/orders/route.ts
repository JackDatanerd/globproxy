import { withApiAuth, parsePage } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { NextResponse } from 'next/server'

// GET /api/v1/orders?limit=50&offset=0&status=paid
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

    let q = supabase
      .from('orders')
      .select('id, gb_amount, amount_usd, payment_status, invoice_number, refunded_usd, refunded_at, created_at, paid_at', { count: 'exact' })
      .eq('user_id', user.id)
      .eq('is_canary', false)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1)
    if (status) q = q.eq('payment_status', status)

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
