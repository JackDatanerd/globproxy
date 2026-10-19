import { withApiAuth } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { redeliverWebhook } from '@/lib/webhooks'
import { NextResponse } from 'next/server'

// POST /api/v1/webhooks/:id/deliveries/:deliveryId/redeliver — re-sends the
// stored event (same event id and body, fresh signature timestamp).
export async function POST(req: Request, context: { params: Promise<{ id: string; deliveryId: string }> }) {
  return withApiAuth(req, 'POST webhook redeliver', async ({ user }) => {
    const { id, deliveryId } = await context.params
    const r = await redeliverWebhook(user.id, deliveryId, id)
    if (r.error === 'Delivery not found' || r.error === 'Webhook not found') return apiError(404, 'not_found', r.error)
    return NextResponse.json({ delivered: r.ok, response_status: r.status ?? null, error: r.ok ? null : r.error ?? null, delivery_id: r.deliveryId ?? null })
  })
}
