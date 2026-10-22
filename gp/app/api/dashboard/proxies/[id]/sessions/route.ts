import { requireMfaVerified } from '@/lib/mfa'
import { createClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { rateLimitedUser } from '@/lib/rateLimit'
import { genSessionId } from '@/lib/proxyEndpoint'
import { NextResponse } from 'next/server'

// Mirrors enforce_proxy_session_limits() (migration 0059) and the v1 API's cap —
// the dashboard used to stop at 50 while the API allowed 200.
const MAX_STICKY_SESSIONS = 200

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock
  const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'proxy-sessions')
  if (throttled) return throttled
  const { data, error } = await supabase
    .from('proxy_sessions')
    .select('id, session_token, label, pinned, collapsed, terminated_at, created_at')
    .eq('credential_id', id)
    .eq('user_id', user.id)
    .is('terminated_at', null)
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: true })

  if (error) {
    console.error('[dashboard/proxies/[id]/sessions] db error:', error)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
  return NextResponse.json({ sessions: data })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock
  // Creating a new sticky session is a write — was missing from the
  // suspended-user sweep in lib/apiAuth.ts (checkout, dashboard/proxies
  // POST, dashboard/sessions/[sessionId]) since this route was added
  // after that pass. Doesn't consume any new bandwidth allocation (the
  // parent credential already reserved it), but a suspended user
  // shouldn't be able to create new working endpoints under it either.
  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended
  // Creating a session is a row insert; the trigger caps bound the table but not
  // the churn of create-and-terminate loops. Same per-user limiter as the sibling routes.
  const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'proxy-sessions')
  if (throttled) return throttled

  // Confirm the credential belongs to this user and is actually sticky —
  // named sessions only make sense for sticky, rotating has no session concept.
  const { data: cred } = await supabase
    .from('proxy_credentials')
    .select('id, session_type')
    .eq('id', id)
    .eq('user_id', user.id)
    .single()

  if (!cred) return NextResponse.json({ error: 'Credential not found' }, { status: 404 })
  if (cred.session_type !== 'sticky') {
    return NextResponse.json({ error: 'Sessions only apply to sticky credentials' }, { status: 400 })
  }

  const body = await req.json().catch(() => ({}))
  // One session (`label`) or a batch (`labels`, 1–MAX_BATCH) created in a single
  // insert — all rows or none, so a scraper that wants twenty fixed IPs doesn't
  // make twenty requests and end up with eleven if one of them fails.
  const MAX_BATCH = 25
  let labels: string[]
  if (Array.isArray(body.labels)) {
    if (body.labels.length < 1 || body.labels.length > MAX_BATCH) {
      return NextResponse.json({ error: `Create between 1 and ${MAX_BATCH} sessions at a time.` }, { status: 400 })
    }
    labels = body.labels.map((l: unknown) => (typeof l === 'string' ? l.trim() : '').slice(0, 100) || 'Session')
  } else {
    labels = [(typeof body.label === 'string' ? body.label.trim() : '').slice(0, 100) || 'Session']
  }

  // Cap live named sessions per credential. Nothing bounded this: each one is
  // a row (and a rendered, polled-on-load list entry), so a script or a stuck
  // double-click loop could create thousands.
  const { count: liveCount } = await supabase
    .from('proxy_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('credential_id', id)
    .eq('user_id', user.id)
    .is('terminated_at', null)
  if ((liveCount ?? 0) + labels.length > MAX_STICKY_SESSIONS) {
    return NextResponse.json({ error: `You can have at most ${MAX_STICKY_SESSIONS} sticky sessions on one credential — delete one you no longer use first.` }, { status: 409 })
  }

  const { data: created, error } = await supabase.from('proxy_sessions').insert(
    labels.map(label => ({
      credential_id: id,
      user_id: user.id,
      session_token: genSessionId(), // fixed at creation — this IS the point of a persisted session
      label,
    }))
  ).select()

  if (error) {
    // The database trigger is the authoritative cap / sticky-only / active-
    // account check; its messages are written for customers.
    if (error.code === '23514') return NextResponse.json({ error: error.message }, { status: 409 })
    if (error.code === '42501') return NextResponse.json({ error: 'Account is not active.' }, { status: 403 })
    console.error('[dashboard/proxies/[id]/sessions] db error:', error)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
  return NextResponse.json({ session: created?.[0] ?? null, sessions: created ?? [] }, { status: 201 })
}
