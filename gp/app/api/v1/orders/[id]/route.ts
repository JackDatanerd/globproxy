import { withApiAuth } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { isUuid } from '@/lib/adminAuth'
import { ORDER_API_COLUMNS, shapeOrder, shapeBilledTo } from '@/lib/orderApi'
import { appUrl } from '@/lib/appUrl'
import { orderTaxSummary } from '@/lib/invoiceTax'
import { NextResponse } from 'next/server'

// GET /api/v1/orders/:id — one purchase: the list's fields plus `billed_to`, the buyer block
// printed on the invoice (null until an invoice exists).
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'GET order', async ({ user, supabase }) => {
    const { id } = await context.params
    if (!isUuid(id)) return apiError(404, 'not_found', 'Order not found')
    const { data: o, error } = await supabase
      .from('orders')
      .select(`${ORDER_API_COLUMNS}, billing_details`)
      .eq('id', id).eq('user_id', user.id).eq('is_canary', false).maybeSingle()
    if (error) {
      console.error('[v1 GET order] query failed', error)
      return apiError(500, 'internal_error', 'Internal error. Please try again.')
    }
    if (!o) return apiError(404, 'not_found', 'Order not found')
    const { data: notes, error: nErr } = await supabase.from('order_refunds')
      .select('order_id, credit_note_number, amount_usd, created_at').eq('order_id', o.id).order('created_at', { ascending: true })
    if (nErr) {
      console.error('[v1 GET order] credit-note query failed', nErr)
      return apiError(500, 'internal_error', 'Internal error. Please try again.')
    }
    return NextResponse.json(shapeOrder(o, { siteUrl: appUrl(), taxOf: orderTaxSummary }, notes ?? [], o.invoice_number ? shapeBilledTo((o as any).billing_details) : null))
  })
}
