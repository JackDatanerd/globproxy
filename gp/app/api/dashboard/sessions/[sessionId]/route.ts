import { requireMfaVerified } from '@/lib/mfa'
import { createClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { rateLimitedUser } from '@/lib/rateLimit'
import { isUuidString } from '@/lib/cursor'
import { parseLabel } from '@/lib/apiValidation'
import { NextResponse } from 'next/server'

export async function PATCH(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params
  // A malformed id reached the uuid column filter and came back as a 500 (the sibling GET/POST already guard this).
  if (!isUuidString(sessionId)) return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock
  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended
  const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'proxy-sessions')
  if (throttled) return throttled

  const body = await req.json().catch(() => ({}))
  const update: Record<string, any> = {}

  if (typeof body.label === 'string') {
    // Same cleaning as session labels everywhere else (control characters stripped, length bounded).
    const label = parseLabel(body.label)
    if (!label.ok) return NextResponse.json({ error: label.error }, { status: 400 })
    update.label = label.value || 'Session'
  }
  if (typeof body.pinned === 'boolean') update.pinned = body.pinned
  if (typeof body.collapsed === 'boolean') update.collapsed = body.collapsed
  if (body.terminate === true) update.terminated_at = new Date().toISOString()

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  // A terminated session is gone (the v1 route answers the same): editing it used to return 200, and
  // terminating twice used to overwrite terminated_at with a later time.
  const q = supabase
    .from('proxy_sessions')
    .update(update)
    .eq('id', sessionId)
    .eq('user_id', user.id)
    .is('terminated_at', null)
  const { data, error } = await q.select().maybeSingle()

  if (error) {
    console.error('[dashboard/sessions/[sessionId]] db error:', error)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
  // .single() turned "not yours / already deleted" into a 500 with Postgres'
  // "JSON object requested, multiple (or no) rows returned" text.
  if (!data) return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  return NextResponse.json({ session: data })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params
  if (!isUuidString(sessionId)) return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock
  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended
  const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'proxy-sessions')
  if (throttled) return throttled

  const { data: deletedRows, error } = await supabase
    .from('proxy_sessions')
    .delete()
    .eq('id', sessionId)
    .eq('user_id', user.id)
    .select('id')

  if (error) {
    console.error('[dashboard/sessions/[sessionId]] db error:', error)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
  if (!deletedRows || deletedRows.length === 0) {
    return NextResponse.json({ error: 'Delete was blocked — nothing was removed.' }, { status: 404 })
  }
  return NextResponse.json({ success: true })
}
