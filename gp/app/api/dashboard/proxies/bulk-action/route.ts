import { requireMfaVerified } from '@/lib/mfa'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { rateLimitedUser } from '@/lib/rateLimit'
import { deleteCredential } from '@/lib/credentials'
import { pauseCredential, resumeCredential } from '@/lib/credentialPause'
import { syncUserUsage } from '@/lib/usageSync'
import { isUuidString } from '@/lib/cursor'
import { NextResponse } from 'next/server'

const MAX_BULK = 20

// POST /api/dashboard/proxies/bulk-action { action: 'pause' | 'resume' | 'delete', ids: [...] }  (max 20)
//
// Dashboard twin of POST /api/v1/sub-users/bulk-action. The bulk bar used to send one
// /pause request PER session, and every one of those ran a full usage sync (a walk over
// every active sub-user against the supplier) — and drew one hit on the per-user rate
// limiter, so a big selection was throttled half-way. Here the sync runs once per request,
// and each item is independent (one failing never stops the rest).
// Response: 200 { results: [{ id, ok, error?, code? }], succeeded, failed }.
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock
  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended
  const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'proxy-bulk')
  if (throttled) return throttled

  const body = await req.json().catch(() => null)
  const action = body?.action
  const ids = body?.ids
  if (action !== 'pause' && action !== 'resume' && action !== 'delete') return NextResponse.json({ error: 'action must be pause, resume or delete.' }, { status: 400 })
  if (!Array.isArray(ids) || ids.length === 0) return NextResponse.json({ error: 'ids must be a non-empty list.' }, { status: 400 })
  if (ids.length > MAX_BULK) return NextResponse.json({ error: `At most ${MAX_BULK} sessions per request.` }, { status: 400 })

  const admin = await createAdminClient()
  if (action === 'pause') await syncUserUsage(user.id).catch((e) => console.error('[dashboard bulk] pre-pause usage sync failed', e))

  const results: { id: string; ok: boolean; error?: string; code?: string }[] = []
  const seen = new Set<string>()
  for (const raw of ids) {
    const id = typeof raw === 'string' ? raw : ''
    if (!isUuidString(id) || seen.has(id)) { results.push({ id, ok: false, error: 'Invalid or repeated session id.', code: 'invalid_request' }); continue }
    seen.add(id)
    const r = action === 'delete'
      ? await deleteCredential(admin, user.id, id, 'dashboard')
      : action === 'pause'
        ? await pauseCredential(admin, user.id, id, { usageSynced: true })
        : await resumeCredential(admin, user.id, id)
    results.push(r.ok ? { id, ok: true } : { id, ok: false, error: r.status === 404 ? 'Session not found' : r.message, code: r.code })
  }
  const succeeded = results.filter(r => r.ok).length
  return NextResponse.json({ results, succeeded, failed: results.length - succeeded })
}
