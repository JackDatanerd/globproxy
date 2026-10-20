import { createClient, createAdminClient } from '@/lib/supabase/server'
import { rateLimitedUser } from '@/lib/rateLimit'
import { requireActiveUser } from '@/lib/apiAuth'
import { listEndpoints, createEndpoint } from '@/lib/webhookEndpoints'
import { NextResponse } from 'next/server'
import { requireStepUp } from '@/lib/reauth'
import { logSecurityEvent, notifySecurityChange } from '@/lib/securityEvents'

// All webhook-endpoint rules live in lib/webhookEndpoints.ts, shared with
// /api/v1/webhooks. `secret` is never selected on list — only the create
// (and rotate-secret) response ever returns it, once.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const r = await listEndpoints(await createAdminClient(), user.id)
  if (!r.ok) return NextResponse.json({ error: r.message }, { status: r.status })
  return NextResponse.json({ webhooks: r.data })
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Per-user throttle (lib/rateLimit.ts) — this route creates an outbound integration on every call.
  const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'webhook-create')
  if (throttled) return throttled

  // 2FA step-up: an account that enabled two-factor must hold a verified
  // session for this action — a password alone isn't enough. See lib/mfa.ts.
  const mfaGate = await requireStepUp(req, user.id)
  if (mfaGate) return mfaGate


  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended

  const body = await req.json().catch(() => ({}))
  const r = await createEndpoint(await createAdminClient(), user.id, body)
  if (!r.ok) return NextResponse.json({ error: r.message }, { status: r.status })
  await logSecurityEvent({ userId: user.id, event: 'webhook_created', req })
  await notifySecurityChange(user.id, 'A new webhook endpoint was added to your GlobProxy account', 'a new webhook endpoint was just added to your account. Account events will be delivered to it.')
  return NextResponse.json({ webhook: r.data })
}
