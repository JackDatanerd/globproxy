import { withApiAuth, failFrom, readJsonBody } from '@/lib/apiHelpers'
import { rotateSecret } from '@/lib/webhookEndpoints'
import { NextResponse } from 'next/server'

// POST /api/v1/webhooks/:id/rotate-secret   body (optional): { "grace_minutes": 0–4320 }
// The new secret is returned once, here. By default the old secret stops
// working immediately (right for a leaked secret). With grace_minutes the old
// secret keeps signing the X-GlobProxy-Signature-V2-Previous header until the
// window lapses, so you can switch receivers over without dropping events.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'POST webhook rotate-secret', async ({ user, supabase }) => {
    const { id } = await context.params
    let grace = 0
    if ((req.headers.get('content-length') ?? '0') !== '0') {
      const json = await readJsonBody(req)
      if (!json.ok) return json.response
      if (json.body?.grace_minutes !== undefined) grace = Number(json.body.grace_minutes)
    }
    const r = await rotateSecret(supabase, user.id, id, grace)
    return r.ok ? NextResponse.json(r.data) : failFrom(r)
  })
}
