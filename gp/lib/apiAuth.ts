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

// A Response's body is a stream that can only be consumed once. This used
// to be a single module-level NextResponse instance reused across every
// unauthorized request — harmless in a fresh Node process per request, but
// in a Workers runtime that reuses the same isolate (and therefore the same
// already-constructed object) across many requests, the *first* 401 to
// actually get serialized consumes that shared stream, and every 401 after
// it in that isolate's lifetime comes back with an empty body — exactly
// the "no error, no body, just nothing" behavior seen after fixing the
// 1101 crash: the crash is what used to mask this, since it never reached
// a clean return in the failure case being tested. A function that builds
// a fresh Response per call sidesteps this entirely.
function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

// Was previously checked ad-hoc, inconsistently, per-route (present in
// admin/delete-user, admin/suspend-user, auth/reset, auth/signup,
// dashboard/api-keys, user/delete-account, and v1 via requireApiAccess
// below — but missing from checkout, dashboard/proxies POST, and
// dashboard/sessions). middleware.ts only signs a suspended user out on
// page navigation; it explicitly excludes /api, so a suspended user with
// an unexpired access token could hit those three routes directly and
// keep purchasing bandwidth / creating credentials. Call this at the top
// of any route that writes on a logged-in user's behalf.
//
// Also checks is_deleted, not just is_suspended — the same gap
// middleware.ts had before migration 0029 existed here too, and unlike
// the page-routing case there's no signup-side precondition needed: this
// only requires an unexpired session token for an account that's since
// been deleted, which is a much easier bar to clear.
export async function requireActiveUser(userId: string): Promise<NextResponse | null> {
  const supabase = await createAdminClient()
  const { data } = await supabase.from('profiles').select('is_suspended, is_deleted').eq('id', userId).single()
  if (data?.is_deleted) {
    return NextResponse.json({ error: 'This account no longer exists.' }, { status: 403 })
  }
  if (data?.is_suspended) {
    return NextResponse.json(
      { error: 'This account has been suspended. Contact support@globproxy.com.' },
      { status: 403 }
    )
  }
  return null
}

export async function requireApiAccess(req: Request): Promise<ApiAuthResult> {
  // Previously nothing in this function was wrapped — any unexpected
  // exception (a rejected Supabase call, a bad getCloudflareContext call,
  // anything) propagated straight out of this shared choke point and
  // crashed the Worker for the request, producing Cloudflare's own raw
  // "error code: 1101" page instead of a clean JSON error. Since every
  // v1 route calls this first, a single unhandled failure here took down
  // every endpoint at once rather than failing one request gracefully.
  try {
    const token = req.headers.get('authorization')?.replace('Bearer ', '')
    const supabase = await createAdminClient()

    if (!token || !token.startsWith('gp_live_')) {
      return { ok: false, response: unauthorized() }
    }

    const key_hash = await sha256Hex(token)
    const { data: apiKey, error: keyErr } = await supabase
      .from('api_keys')
      .select('id, user_id, revoked_at')
      .eq('key_hash', key_hash)
      .single()

    // .single() reports "no rows" as an error (not a thrown exception) —
    // that's the expected shape for "no such key," same as revoked below.
    // Anything else in keyErr is unexpected and falls through to the
    // catch block's 500 rather than being silently treated as "not found."
    if (keyErr && keyErr.code !== 'PGRST116') throw keyErr
    if (!apiKey || apiKey.revoked_at) {
      return { ok: false, response: unauthorized() }
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('id, email, role, api_access, is_suspended, is_deleted')
      .eq('id', apiKey.user_id)
      .single()

    if (!profile) {
      return { ok: false, response: unauthorized() }
    }

    // Same check as requireActiveUser above, and the same gap
    // middleware.ts had before migration 0029: neither delete-account nor
    // admin/delete-user ever revoked a user's existing api_keys rows, so
    // without this a key generated before deletion just kept
    // authenticating against every v1 route indefinitely — no expired
    // token, no signup edge case needed, the key itself never stopped
    // working. Treated as unauthorized rather than the 403s below since
    // there's no account left to be "forbidden" for. See migration 0030
    // for the backfill that revokes every currently-deleted account's
    // outstanding keys.
    if (profile.is_deleted) {
      return { ok: false, response: unauthorized() }
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
  } catch (e) {
    console.error('[requireApiAccess] unexpected error:', e)
    return {
      ok: false,
      response: NextResponse.json({ error: 'Internal error validating API key. Please try again.' }, { status: 500 }),
    }
  }
}
