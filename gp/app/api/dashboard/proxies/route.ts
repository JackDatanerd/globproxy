import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { parseCreateCredential, parseAutoTopup } from '@/lib/apiValidation'
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
  // Same strict parser as the auto-top-up route and the v1 API (bounds, no
  // null-becomes-0, amount > threshold).
  const auto = parseAutoTopup({
    // Strictly `=== true`: an absent / null / non-boolean flag means "off" for this optional create-time setting.
    enabled: body?.auto_topup_enabled === true,
    threshold_gb: body?.auto_topup_threshold_gb,
    amount_gb: body?.auto_topup_amount_gb,
  })
  if (!auto.ok) return NextResponse.json({ error: auto.error }, { status: 400 })
  const autoTopup = auto.value.enabled
    ? { threshold_gb: auto.value.threshold_gb, amount_gb: auto.value.amount_gb }
    : null

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
