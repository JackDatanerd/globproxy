import { withApiAuth, failFrom } from '@/lib/apiHelpers'
import { getDelivery } from '@/lib/webhookEndpoints'
import { NextResponse } from 'next/server'

// GET /api/v1/webhooks/:id/deliveries/:deliveryId — one delivery in full: the
// exact event body that was sent (`payload`) and the first 500 characters of
// your endpoint's last response (`response_body`).
export async function GET(req: Request, context: { params: Promise<{ id: string; deliveryId: string }> }) {
  return withApiAuth(req, 'GET webhook delivery', async ({ user, supabase }) => {
    const { id, deliveryId } = await context.params
    const r = await getDelivery(supabase, user.id, id, deliveryId)
    return r.ok ? NextResponse.json(r.data) : failFrom(r)
  })
}
