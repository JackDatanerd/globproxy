import { requireMfaVerified } from '@/lib/mfa'
import { createClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { genSessionId } from '@/lib/proxyEndpoint'
import { NextResponse } from 'next/server'

const MAX_STICKY_SESSIONS = 50

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock
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
  const label = (typeof body.label === 'string' ? body.label.trim() : '').slice(0, 100) || 'Session'

  // Cap live named sessions per credential. Nothing bounded this: each one is
  // a row (and a rendered, polled-on-load list entry), so a script or a stuck
  // double-click loop could create thousands.
  const { count: liveCount } = await supabase
    .from('proxy_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('credential_id', id)
    .eq('user_id', user.id)
    .is('terminated_at', null)
  if ((liveCount ?? 0) >= MAX_STICKY_SESSIONS) {
    return NextResponse.json({ error: `You can have at most ${MAX_STICKY_SESSIONS} sticky sessions on one credential — delete one you no longer use first.` }, { status: 409 })
  }

  const { data, error } = await supabase.from('proxy_sessions').insert({
    credential_id: id,
    user_id: user.id,
    session_token: genSessionId(), // fixed at creation — this IS the point of a persisted session
    label,
  }).select().single()

  if (error) {
    console.error('[dashboard/proxies/[id]/sessions] db error:', error)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
  return NextResponse.json({ session: data }, { status: 201 })
}
