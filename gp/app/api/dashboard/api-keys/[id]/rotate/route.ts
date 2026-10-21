import { createAdminClient, createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { rateLimitedUser } from '@/lib/rateLimit'
import { requireStepUp } from '@/lib/reauth'
import { logSecurityEvent, notifySecurityChange } from '@/lib/securityEvents'
import { rotateApiKey, notifyKeyEvent } from '@/lib/apiKeys'

// POST /api/dashboard/api-keys/:id/rotate   body (optional): { grace_hours?: 0–72 (default 24) }
// Issues a replacement key (same label, scopes, IP allowlist and lifespan) and
// lets the old one keep working for the grace window so the new secret can be
// deployed without an outage. grace_hours: 0 revokes the old key immediately —
// use that when the old secret leaked. The new plaintext is returned once.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Per-user throttle — rotating mints a credential on every call.
  const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'api-key-rotate')
  if (throttled) return throttled

  const gate = await requireStepUp(req, user.id)
  if (gate) return gate
  const inactive = await requireActiveUser(user.id)
  if (inactive) return inactive

  const { id } = await context.params
  const body = await req.json().catch(() => ({}))
  const grace = body?.grace_hours === undefined ? 24 : Number(body.grace_hours)

  const admin = await createAdminClient()
  const r = await rotateApiKey(admin, user.id, id, grace)
  if (!r.ok) return NextResponse.json({ error: r.message }, { status: r.status })

  await logSecurityEvent({ userId: user.id, event: 'api_key_rotated', req, admin, meta: { new_key_prefix: r.data.meta.key_prefix, old_key_valid_until: r.data.old_key_valid_until } })
  await notifySecurityChange(user.id, 'An API key on your GlobProxy account was rotated', `an API key was rotated; the replacement starts ${r.data.meta.key_prefix}…. ${r.data.old_key_valid_until ? 'The old key keeps working until ' + r.data.old_key_valid_until.slice(0, 16).replace('T', ' ') + ' UTC.' : 'The old key was revoked immediately.'}`)
  await notifyKeyEvent(user.id, 'api_key_created', r.data.meta, { rotated_from: r.data.old.id })
  // A key revoked on the spot (grace 0) is a revocation like any other — receivers
  // that mirror key state must hear about it. A graced old key simply lapses.
  if (r.data.old.revoked) await notifyKeyEvent(user.id, 'api_key_revoked', r.data.old, { reason: 'rotated', replaced_by: r.data.meta.id })
  return NextResponse.json({ key: r.data.plaintext, meta: r.data.meta, old_key_valid_until: r.data.old_key_valid_until }, { status: 201 })
}
