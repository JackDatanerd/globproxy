import { rejectCrossSite } from '@/lib/apiAuth'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { rateLimited } from '@/lib/rateLimit'
import { logSecurityEvent } from '@/lib/securityEvents'
import { sessionIdFromJwt } from '@/lib/mfa'
import { NextResponse } from 'next/server'

// Signed-in devices. GoTrue keeps one row per login in auth.sessions; two
// SECURITY DEFINER helpers (migration 0043, service_role only) list and revoke
// them. The raw rows hold more than the browser should see, so only a fixed
// set of fields is forwarded.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: { session } } = await supabase.auth.getSession()
  const current = sessionIdFromJwt(session?.access_token)

  const admin = await createAdminClient()
  const { data, error } = await admin.rpc('list_auth_sessions', { p_user_id: user.id })
  if (error) {
    console.error('[auth/sessions] list failed', user.id, error.message)
    return NextResponse.json({ error: 'Could not load your devices right now.' }, { status: 503 })
  }
  const rows = (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>
  return NextResponse.json({
    sessions: rows.map(r => ({
      id: String(r.id),
      created_at: (r.created_at as string) ?? null,
      last_active: ((r.refreshed_at ?? r.updated_at ?? r.created_at) as string) ?? null,
      user_agent: typeof r.user_agent === 'string' ? r.user_agent.slice(0, 300) : null,
      ip: typeof r.ip === 'string' ? r.ip : null,
      current: String(r.id) === current,
    })),
  })
}

export async function DELETE(req: Request) {
  const cross = rejectCrossSite(req)
  if (cross) return cross

  const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', 'password')
  if (limited) return limited

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: { session } } = await supabase.auth.getSession()

  const { id } = await req.json().catch(() => ({}))
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'Missing device id.' }, { status: 400 })
  }
  if (id === sessionIdFromJwt(session?.access_token)) {
    return NextResponse.json({ error: 'That is the device you are using now — use Sign out instead.' }, { status: 400 })
  }

  const admin = await createAdminClient()
  const { data: removed, error } = await admin.rpc('revoke_auth_session', { p_user_id: user.id, p_session_id: id })
  if (error) {
    console.error('[auth/sessions] revoke failed', user.id, error.message)
    return NextResponse.json({ error: 'Could not sign that device out. Please try again.' }, { status: 500 })
  }
  if (removed) await logSecurityEvent({ userId: user.id, event: 'session_revoked', req, admin })
  return NextResponse.json({ success: true })
}
