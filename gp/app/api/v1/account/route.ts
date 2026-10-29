import { withApiAuth } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { NextResponse } from 'next/server'
import { passwordRotationEnabled } from '@/lib/credentials'

// GET /api/v1/account — who this key belongs to and what it may do. Lets an
// integration check its own scopes / expiry (and warn before it lapses)
// without guessing from 403s. `features` reports which optional endpoints are live.
export async function GET(req: Request) {
  return withApiAuth(req, 'GET account', async ({ user, supabase, key }) => {
    const { data: k, error } = await supabase
      .from('api_keys').select('id, key_prefix, label, scopes, allowed_ips, expires_at, created_at')
      .eq('id', key.id).maybeSingle()
    const { data: p, error: pErr } = await supabase.from('profiles').select('role, email').eq('id', user.id).maybeSingle()
    // A failed lookup is not "no role": answering 200 with role: null told an integration it was not a reseller.
    if (error || pErr || !k) {
      console.error('[v1 GET account] lookup failed', error ?? pErr)
      return apiError(500, 'internal_error', 'Internal error. Please try again.')
    }
    return NextResponse.json({
      account: { id: user.id, email: p?.email ?? user.email ?? null, role: p?.role ?? null },
      api_key: {
        id: k.id, key_prefix: k.key_prefix, label: k.label, scopes: k.scopes,
        allowed_ips: k.allowed_ips ?? [], expires_at: k.expires_at, created_at: k.created_at,
      },
      // Capabilities that are switched on per deployment, so an integration can
      // check instead of discovering a 503. rotate-password answers 503 while
      // password_rotation is false.
      features: { password_rotation: passwordRotationEnabled() },
    })
  })
}
