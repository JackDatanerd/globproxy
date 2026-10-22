import { withApiAuth, failFrom } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { rotateSecret } from '@/lib/webhookEndpoints'
import { NextResponse } from 'next/server'
import { auditWebhookChange, hostOf } from '@/lib/integrationAudit'

// POST /api/v1/webhooks/:id/rotate-secret   body (optional): { "grace_minutes": 0–4320 }
// The new secret is returned once, here. By default the old secret stops
// working immediately (right for a leaked secret). With grace_minutes the old
// secret keeps signing the X-GlobProxy-Signature-V2-Previous header until the
// window lapses, so you can switch receivers over without dropping events.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'POST webhook rotate-secret', async ({ user, supabase, key }) => {
    const { id } = await context.params
    // Read the body whatever the transfer encoding: gating on Content-Length
    // dropped grace_minutes from chunked requests, so the old secret died at
    // once instead of overlapping.
    let grace = 0
    const raw = (await req.text().catch(() => '')).trim()
    if (raw) {
      let body: any
      try { body = JSON.parse(raw) } catch { return apiError(400, 'invalid_request', 'Request body must be valid JSON.') }
      if (body?.grace_minutes !== undefined && body.grace_minutes !== null) grace = Number(body.grace_minutes)
    }
    const r = await rotateSecret(supabase, user.id, id, grace)
    if (!r.ok) return failFrom(r)
    await auditWebhookChange({ userId: user.id, event: 'webhook_secret_rotated', req, via: 'api', webhookId: id, keyId: key.id })
    return NextResponse.json(r.data)
  })
}
