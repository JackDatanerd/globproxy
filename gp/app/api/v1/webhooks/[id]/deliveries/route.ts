import { withApiAuth, failFrom } from '@/lib/apiHelpers'
import { listDeliveries } from '@/lib/webhookEndpoints'
import { NextResponse } from 'next/server'

// GET /api/v1/webhooks/:id/deliveries?limit=50&status=failed — kept 14 days.
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'GET webhook deliveries', async ({ user, supabase }) => {
    const { id } = await context.params
    const url = new URL(req.url)
    const r = await listDeliveries(supabase, user.id, id, { limit: Number(url.searchParams.get('limit')) || undefined, status: url.searchParams.get('status') })
    return r.ok ? NextResponse.json({ deliveries: r.data }) : failFrom(r)
  })
}
