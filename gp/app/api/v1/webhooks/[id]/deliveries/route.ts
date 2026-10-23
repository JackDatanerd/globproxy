import { withApiAuth, failFrom } from '@/lib/apiHelpers'
import { listDeliveries } from '@/lib/webhookEndpoints'
import { NextResponse } from 'next/server'

// GET /api/v1/webhooks/:id/deliveries?limit=50&status=failed&event_type=session_created&before=<ISO>
// Newest first, kept 14 days. When has_more is true, pass next_before as
// `before` and next_before_id as `before_id` to get the next (older) page.
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'GET webhook deliveries', async ({ user, supabase }) => {
    const { id } = await context.params
    const url = new URL(req.url)
    const limit = Math.min(Math.max(Math.trunc(Number(url.searchParams.get('limit'))) || 50, 1), 100)
    const r = await listDeliveries(supabase, user.id, id, { limit, status: url.searchParams.get('status'), eventType: url.searchParams.get('event_type'), before: url.searchParams.get('before'), beforeId: url.searchParams.get('before_id') })
    if (!r.ok) return failFrom(r)
    const rows = r.data.rows
    const hasMore = r.data.has_more
    return NextResponse.json({
      deliveries: rows,
      has_more: hasMore,
      next_before: hasMore ? rows[rows.length - 1].created_at : null,
      next_before_id: hasMore ? rows[rows.length - 1].id : null,
    })
  })
}
