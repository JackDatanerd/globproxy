import { createAdminClient } from '@/lib/supabase/server'
import { getCloudflareContext } from '@opennextjs/cloudflare'
import { NextResponse } from 'next/server'

// Shared gate for every app/api/v1/* route.
//
// This used to call supabase.auth.getUser(token) — i.e. it treated the
// bearer token as a Supabase session JWT. That's what the "API Keys" page
// was showing users (their live session access_token), which meant:
//   - it expired roughly hourly, breaking any real automation built on it
//   - it was a full session-equivalent credential, not scoped to the API
//   - there was no way to revoke a "key" independent of signing out
// Real API keys now live in the api_keys table (migration 0005) — this
// looks up the SHA-256 hash of the bearer token there instead.
export type ApiAuthResult =
  | { ok: true; user: { id: string; email?: string }; supabase: Awaited<ReturnType<typeof createAdminClient>> }
  | { ok: false; response: NextResponse }

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

const UNAUTHORIZED = NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

// Was previously checked ad-hoc, inconsistently, per-route (present in
// admin/delete-user, admin/suspend-user, auth/reset, auth/signup,
// dashboard/api-keys, user/delete-account, and v1 via requireApiAccess
// below — but missing from checkout, dashboard/proxies POST, and
// dashboard/sessions). middleware.ts only signs a suspended user out on
// page navigation; it explicitly excludes /api, so a suspended user with
// an unexpired access token could hit those three routes directly and
// keep purchasing bandwidth / creating credentials. Call this at the top
// of any route that writes on a logged-in user's behalf.
export async function requireActiveUser(userId: string): Promise<NextResponse | null> {
  const supabase = await createAdminClient()
  const { data } = await supabase.from('profiles').select('is_suspended').eq('id', userId).single()
  if (data?.is_suspended) {
    return NextResponse.json(
      { error: 'This account has been suspended. Contact support@globproxy.com.' },
      { status: 403 }
    )
  }
  return null
}

export async function requireApiAccess(req: Request): Promise<ApiAuthResult> {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  const supabase = await createAdminClient()

  if (!token || !token.startsWith('gp_live_')) {
    return { ok: false, response: UNAUTHORIZED }
  }

  const key_hash = await sha256Hex(token)
  const { data: apiKey } = await supabase
    .from('api_keys')
    .select('id, user_id, revoked_at')
    .eq('key_hash', key_hash)
    .single()

  if (!apiKey || apiKey.revoked_at) {
    return { ok: false, response: UNAUTHORIZED }
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, email, role, api_access, is_suspended')
    .eq('id', apiKey.user_id)
    .single()

  if (!profile) {
    return { ok: false, response: UNAUTHORIZED }
  }

  if (profile.is_suspended) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'This account has been suspended. Contact support@globproxy.com.' }, { status: 403 }),
    }
  }

  if (profile.role === 'user') {
    return {
      ok: false,
      response: NextResponse.json(
        // Was pointing at globproxy.com/reseller, which doesn't exist as
        // its own page — the reseller program is a homepage section
        // (id="reseller"), not a standalone route. Pointing at the actual
        // anchor instead of a dead link.
        { error: 'API access is available to resellers. See globproxy.com/#reseller to apply.' },
        { status: 403 }
      ),
    }
  }

  if (!profile.api_access && profile.role !== 'admin') {
    return {
      ok: false,
      response: NextResponse.json(
        // This account is already a reseller — send them to the actual
        // in-app request flow (see /dashboard/api-keys and
        // /api/dashboard/apply-api-access) rather than back to the
        // reseller sign-up they've already completed.
        { error: 'API access is not enabled for your account. Apply from API Keys in your dashboard.' },
        { status: 403 }
      ),
    }
  }

  // Fire-and-forget usage tracking — not worth failing the request over,
  // but a bare un-awaited promise like this can get cancelled by the
  // Workers runtime the moment the response is returned, since nothing
  // tells it the invocation isn't done yet. waitUntil() keeps the
  // invocation alive until this actually completes, without making the
  // caller wait for it. Falls back to the old fire-and-forget behavior if
  // the Cloudflare context isn't available (e.g. local dev outside
  // wrangler) rather than throwing.
  const updateLastUsed = supabase.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', apiKey.id).then(() => {}, () => {})
  try {
    getCloudflareContext({ async: false }).ctx.waitUntil(updateLastUsed)
  } catch {
    // Not running in a Workers context — nothing to attach to, just let it run.
  }

  return { ok: true, user: { id: profile.id, email: profile.email }, supabase }
}
