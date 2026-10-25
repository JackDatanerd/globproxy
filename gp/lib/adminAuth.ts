import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requireMfaVerified, isMfaEnrolled } from '@/lib/mfa'
import { requireStepUp } from '@/lib/reauth'

export type AdminSupabase = Awaited<ReturnType<typeof createAdminClient>>

export type AdminAuthResult =
  | { ok: true; supabase: AdminSupabase; adminId: string }
  | { ok: false; response: NextResponse }

// The shared front door for every /api/admin/* route: Bearer token ->
// real user -> role === 'admin' -> TOTP step-up cookie. Same order and
// same status codes the routes each used to hand-roll (401 / 403 / 403),
// pulled into one place so a future route can't forget the MFA step.
//
// `opts.stepUp` demands the full step-up on a GET too. Use it for reads that
// hand over bulk sensitive data (CSV exports of payout destinations / the audit
// log): a plain read only needs the verified 2FA cookie; the full step-up asks for a
// fresh code on top, so a stolen session alone can't export them.
export async function authorizeAdmin(req: Request, opts: { stepUp?: boolean } = {}): Promise<AdminAuthResult> {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const supabase = await createAdminClient()
  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const { data: profile } = await supabase
    .from('profiles').select('role, is_deleted, is_suspended').eq('id', user.id).single()
  if (profile?.role !== 'admin') return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  // The page middleware already refuses a suspended / deleted admin; the API
  // used to accept their still-valid JWT until it expired.
  if (profile.is_deleted || profile.is_suspended) {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }

  // 2FA is REQUIRED for administrators (middleware.ts sends an unenrolled admin to setup; this
  // is the API-side backstop, e.g. for a Bearer token minted before the rule). Fails closed: if
  // enrollment can't be read, the request is refused rather than waved through.
  let enrolled = false
  try { enrolled = await isMfaEnrolled(user.id, supabase) } catch (e) {
    console.error('[adminAuth] could not read 2FA enrollment — refusing', user.id, e)
    return { ok: false, response: NextResponse.json({ error: 'Could not verify your account right now. Please try again in a moment.' }, { status: 503 }) }
  }
  if (!enrolled) {
    return { ok: false, response: NextResponse.json(
      { error: 'Two-factor authentication is required for administrator accounts. Turn it on to continue.', code: 'mfa_enrollment_required' },
      { status: 403 }
    ) }
  }

  // Reads need the verified second factor. Anything that
  // changes state needs the full step-up: a fresh authenticator code (every
  // admin is enrolled, see above) — otherwise a stolen admin session alone could
  // change roles, mark payouts paid or reset someone's 2FA with no further proof.
  const isRead = req.method === 'GET' || req.method === 'HEAD'
  const mfaCheck = isRead && !opts.stepUp ? await requireMfaVerified(req, user.id) : await requireStepUp(req, user.id)
  if (mfaCheck) return { ok: false, response: mfaCheck }

  return { ok: true, supabase, adminId: user.id }
}

// A malformed / empty body used to throw out of req.json() and surface as
// an opaque 500 from routes without a try/catch. Returns null instead so
// the caller can answer 400.
export async function readJson<T = Record<string, any>>(req: Request): Promise<T | null> {
  try {
    const body = await req.json()
    return body && typeof body === 'object' ? (body as T) : null
  } catch {
    return null
  }
}

export function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

// Real calendar-date check for YYYY-MM-DD strings (the regex alone lets
// 2026-13-45 through).
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(v + 'T00:00:00Z')
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}
