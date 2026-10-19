import { withApiAuth } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { sendTestWebhook } from '@/lib/webhooks'
import { NextResponse } from 'next/server'

// POST /api/v1/webhooks/:id/test — sends a signed `test` event now.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'POST webhook test', async ({ user }) => {
    const { id } = await context.params
    const r = await sendTestWebhook(user.id, id)
    if (r.cooldown) return apiError(429, 'rate_limited', r.error ?? 'Please wait before sending another test.', { 'Retry-After': '10' })
    if (r.error === 'Webhook not found') return apiError(404, 'not_found', 'Webhook not found')
    return NextResponse.json({ delivered: r.ok, response_status: r.status ?? null, error: r.ok ? null : r.error ?? null, delivery_id: r.deliveryId ?? null })
  })
}
