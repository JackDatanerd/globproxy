import { createAdminClient } from '@/lib/supabase/server'
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
        { error: 'API access is not enabled for your account. Apply at globproxy.com/reseller.' },
        { status: 403 }
      ),
    }
  }

  if (!profile.api_access && profile.role !== 'admin') {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'API access is not enabled for your account. Apply at globproxy.com/reseller.' },
        { status: 403 }
      ),
    }
  }

  // Fire-and-forget usage tracking — not worth failing the request over.
  supabase.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', apiKey.id).then(() => {}, () => {})

  return { ok: true, user: { id: profile.id, email: profile.email }, supabase }
}
