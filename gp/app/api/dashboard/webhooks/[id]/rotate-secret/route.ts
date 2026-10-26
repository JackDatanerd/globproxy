import { createClient, createAdminClient } from '@/lib/supabase/server'
import { rateLimitedUser } from '@/lib/rateLimit'
import { requireActiveUser } from '@/lib/apiAuth'
import { rotateSecret } from '@/lib/webhookEndpoints'
import { graceInput } from '@/lib/apiKeys'
import { requireStepUp } from '@/lib/reauth'
import { auditWebhookChange, hostOf } from '@/lib/integrationAudit'
import { NextResponse } from 'next/server'

// Replaces the signing secret; the new one is returned once, in this response.
// The old one stops working immediately unless the body asks for a grace
// window: { "grace_minutes": 0–4320 } keeps it signing
// X-GlobProxy-Signature-V2-Previous until then.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Per-user throttle (lib/rateLimit.ts) — this route rotates a signing secret on every call.
  const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'webhook-rotate')
  if (throttled) return throttled

  // 2FA step-up, same as webhook create/update: rotating the signing secret
  // is a security-sensitive change. See lib/mfa.ts.
  const mfaGate = await requireStepUp(req, user.id)
  if (mfaGate) return mfaGate

  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended

  const { id } = await context.params
  const body = await req.json().catch(() => ({}))
  const r = await rotateSecret(await createAdminClient(), user.id, id, graceInput(body?.grace_minutes, 0))
  if (!r.ok) return NextResponse.json({ error: r.message }, { status: r.status })
  await auditWebhookChange({ userId: user.id, event: 'webhook_secret_rotated', req, via: 'dashboard', webhookId: id })
  return NextResponse.json(r.data)
}
