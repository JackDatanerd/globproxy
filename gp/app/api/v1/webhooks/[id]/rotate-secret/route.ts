import { withApiAuth, failFrom } from '@/lib/apiHelpers'
import { rotateSecret } from '@/lib/webhookEndpoints'
import { NextResponse } from 'next/server'

// POST /api/v1/webhooks/:id/rotate-secret — the old secret stops working
// immediately; the new one is returned once, here.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'POST webhook rotate-secret', async ({ user, supabase }) => {
    const { id } = await context.params
    const r = await rotateSecret(supabase, user.id, id)
    return r.ok ? NextResponse.json({ id: r.data.id, secret: r.data.secret }) : failFrom(r)
  })
}
