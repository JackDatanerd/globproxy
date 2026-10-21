import { withApiAuth } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { isUuid } from '@/lib/adminAuth'
import { NextResponse } from 'next/server'

// GET /api/v1/orders/:id — one purchase (same fields as the list).
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'GET order', async ({ user, supabase }) => {
    const { id } = await context.params
    if (!isUuid(id)) return apiError(404, 'not_found', 'Order not found')
    const { data: o, error } = await supabase
      .from('orders')
      .select('id, gb_amount, amount_usd, payment_status, invoice_number, refunded_usd, refunded_at, created_at, paid_at')
      .eq('id', id).eq('user_id', user.id).eq('is_canary', false).maybeSingle()
    if (error) {
      console.error('[v1 GET order] query failed', error)
      return apiError(500, 'internal_error', 'Internal error. Please try again.')
    }
    if (!o) return apiError(404, 'not_found', 'Order not found')
    return NextResponse.json({
      id: o.id, gb_amount: Number(o.gb_amount), amount_usd: Number(o.amount_usd), status: o.payment_status,
      invoice_number: o.invoice_number, refunded_usd: Number(o.refunded_usd ?? 0), refunded_at: o.refunded_at,
      created_at: o.created_at, paid_at: o.paid_at,
    })
  })
}
