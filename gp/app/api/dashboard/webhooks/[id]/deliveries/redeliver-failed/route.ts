import { requireMfaVerified } from '@/lib/mfa'
import { createClient } from '@/lib/supabase/server'
import { rateLimitedUser } from '@/lib/rateLimit'
import { requireActiveUser } from '@/lib/apiAuth'
import { redeliverFailedWebhooks } from '@/lib/webhooks'
import { NextResponse } from 'next/server'

// Catch-up after an outage: re-sends this endpoint's failed deliveries, oldest first
// (same event ids and bodies, fresh signature timestamps) — the dashboard twin of
// POST /api/v1/webhooks/:id/deliveries/redeliver-failed. At most `limit` (1–10,
// default 5) per call; it stops after two failures in a row, so call it again while
// `more_failed` is true.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Each call makes up to 10 outbound requests to the customer's endpoint.
  const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'webhook-redeliver-failed')
  if (throttled) return throttled

  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock
  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended

  const { id } = await context.params
  const body = await req.json().catch(() => ({}))
  let limit = 5
  if (body?.limit !== undefined) {
    limit = Number(body.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) return NextResponse.json({ error: 'limit must be a whole number from 1 to 10.' }, { status: 400 })
  }
  const r = await redeliverFailedWebhooks(user.id, id, limit)
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.error === 'Webhook not found' ? 404 : 500 })
  return NextResponse.json({ attempted: r.attempted, succeeded: r.succeeded, more_failed: r.more_failed, stopped_early: r.stopped_early })
}
