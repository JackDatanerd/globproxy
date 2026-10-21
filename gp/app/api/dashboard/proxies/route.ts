import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { parseCreateCredential, parseFiniteNumber } from '@/lib/apiValidation'
import { createCredential } from '@/lib/credentials'
import { rateLimited, rateLimitedUser } from '@/lib/rateLimit'
import { NextResponse } from 'next/server'
import { requireMfaVerified } from '@/lib/mfa'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // 2FA step-up: an account that enabled two-factor must hold a verified
  // session for this action — a password alone isn't enough. See lib/mfa.ts.
  const mfaGate = await requireMfaVerified(req, user.id)
  if (mfaGate) return mfaGate


  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended

  // Every create costs real upstream calls on the one shared reseller key;
  // the public API is limited per key (lib/apiAuth.ts), the dashboard path had
  // no limit at all. Same shared limiter binding as usage/history.
  const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', `proxy-create:${user.id}`)
  if (limited) return limited
  const perUser = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'proxy-create')
  if (perUser) return perUser

  const body = await req.json().catch(() => null)

  // Same validator as POST /api/v1/sub-users, run BEFORE anything is
  // reserved or created upstream.
  const parsed = parseCreateCredential(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  // Auto-allocate config is validated up front too (set_auto_topup() makes
  // the same checks at the DB layer; duplicated so a typo fails with no side
  // effects instead of after a reservation and a real sub-user exist).
  let autoTopup: { threshold_gb: number; amount_gb: number } | null = null
  if (body?.auto_topup_enabled === true) {
    const threshold = parseFiniteNumber(body.auto_topup_threshold_gb)
    const amount = parseFiniteNumber(body.auto_topup_amount_gb)
    if (threshold === null || threshold < 0) {
      return NextResponse.json({ error: 'auto_topup_threshold_gb must be a number ≥ 0' }, { status: 400 })
    }
    if (amount === null || amount <= 0) {
      return NextResponse.json({ error: 'auto_topup_amount_gb must be a number greater than 0' }, { status: 400 })
    }
    // The top-up must lift the session above its own threshold, or the cron
    // would re-fire on every tick and drain the account balance into it.
    if (amount <= threshold) {
      return NextResponse.json({ error: 'auto_topup_amount_gb must be greater than auto_topup_threshold_gb' }, { status: 400 })
    }
    autoTopup = { threshold_gb: threshold, amount_gb: amount }
  }

  // Reserve/release are service_role-only (migration 0040), so this goes
  // through the admin client — the user's identity was verified above.
  const admin = await createAdminClient()
  const result = await createCredential(admin, user.id, parsed.value, { source: 'dashboard', autoTopup })
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: result.status })

  return NextResponse.json({
    success: true,
    id: result.data.cred.id,
    status: result.data.cred.status,
    warning: result.data.warning,
  })
}
