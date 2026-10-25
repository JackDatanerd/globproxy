import { requireMfaVerified } from '@/lib/mfa'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { rateLimitedUser } from '@/lib/rateLimit'
import { deleteCredential, topupCredential, updateCredentialSettings } from '@/lib/credentials'
import { parseGbAmount } from '@/lib/apiValidation'
import { pauseCredential, resumeCredential } from '@/lib/credentialPause'
import { syncUserUsage } from '@/lib/usageSync'
import { isUuidString } from '@/lib/cursor'
import { NextResponse } from 'next/server'

const MAX_BULK = 20
// Top-up pushes the new cap to the supplier per session (several upstream calls each), so a
// request carries fewer of them to stay inside the Workers subrequest budget.
const MAX_BULK_TOPUP = 10

// POST /api/dashboard/proxies/bulk-action { action: 'pause' | 'resume' | 'delete', ids: [...] }  (max 20)
//   or    { action: 'topup', ids: [...], gb_amount }  (max 10 — adds gb_amount to EACH session)
//   or    { action: 'retarget', ids: [...], country }  (max 20 — moves each session's exit country;
//          a changed country clears that session's state/city/ASN, as the single edit does)
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
  if (!['pause', 'resume', 'delete', 'topup', 'retarget'].includes(action)) return NextResponse.json({ error: 'action must be pause, resume, delete, topup or retarget.' }, { status: 400 })
  if (!Array.isArray(ids) || ids.length === 0) return NextResponse.json({ error: 'ids must be a non-empty list.' }, { status: 400 })
  const maxIds = action === 'topup' ? MAX_BULK_TOPUP : MAX_BULK
  if (ids.length > maxIds) return NextResponse.json({ error: `At most ${maxIds} sessions per request.` }, { status: 400 })
  let gbAmount = 0
  if (action === 'topup') {
    const gb = parseGbAmount(body?.gb_amount)
    if (!gb.ok) return NextResponse.json({ error: gb.error }, { status: 400 })
    gbAmount = gb.value
  }
  let country = ''
  if (action === 'retarget') {
    if (typeof body?.country !== 'string' || body.country.trim() === '') return NextResponse.json({ error: 'country is required.' }, { status: 400 })
    country = body.country.trim()
  }

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
      : action === 'topup'
        ? await topupCredential(admin, user.id, id, gbAmount, 'dashboard')
        : action === 'retarget'
          ? await updateCredentialSettings(admin, user.id, id, { country }, 'dashboard')
          : action === 'pause'
            ? await pauseCredential(admin, user.id, id, { usageSynced: true })
            : await resumeCredential(admin, user.id, id)
    results.push(r.ok ? { id, ok: true } : { id, ok: false, error: r.status === 404 ? 'Session not found' : r.message, code: r.code })
  }
  const succeeded = results.filter(r => r.ok).length
  return NextResponse.json({ results, succeeded, failed: results.length - succeeded })
}
