import { withApiAuth, readJsonBody } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { parseLabel } from '@/lib/apiValidation'
import { getOwnedCredential } from '@/lib/credentials'
import { buildProxyUsername, genSessionId } from '@/lib/proxyEndpoint'
import { NextResponse } from 'next/server'
import { leaksSupplier } from '@/lib/supplierGuard'

const MAX_ACTIVE_SESSIONS = 200

function view(s: any, cred: any) {
  return {
    id: s.id, label: s.label, pinned: s.pinned, collapsed: s.collapsed,
    session_token: s.session_token,
    // Ready-to-use username that pins this session's exit IP.
    // Never built from a username that names the supplier (same guard as toApiCredential).
    connection_username: cred.upstream_username && !leaksSupplier(cred.upstream_username) ? buildProxyUsername(cred.upstream_username, cred, s.session_token) : null,
    created_at: s.created_at,
  }
}

// GET /api/v1/sub-users/:id/sessions — named sticky sessions on a sticky sub-user.
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'GET sessions', async ({ user, supabase }) => {
    const { id } = await context.params
    const cred = await getOwnedCredential(supabase, user.id, id)
    if (!cred) return apiError(404, 'not_found', 'Sub-user not found')

    const { data, error } = await supabase
      .from('proxy_sessions')
      .select('id, session_token, label, pinned, collapsed, created_at')
      .eq('credential_id', id).eq('user_id', user.id).is('terminated_at', null)
      .order('pinned', { ascending: false }).order('created_at', { ascending: true })
    if (error) {
      console.error('[v1 GET sessions] query failed', error)
      return apiError(500, 'internal_error', 'Internal error. Please try again.')
    }
    return NextResponse.json({ sessions: (data ?? []).map((s) => view(s, cred)) })
  })
}

// POST /api/v1/sub-users/:id/sessions  { "label": "scraper-1" }
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'POST sessions', async ({ user, supabase }) => {
    const { id } = await context.params
    const json = await readJsonBody(req)
    if (!json.ok) return json.response
    const label = parseLabel(json.body?.label)
    if (!label.ok) return apiError(400, 'invalid_request', label.error)

    const cred = await getOwnedCredential(supabase, user.id, id)
    if (!cred) return apiError(404, 'not_found', 'Sub-user not found')
    if (cred.session_type !== 'sticky') return apiError(400, 'invalid_request', 'Sessions only apply to sticky sub-users.')

    const { count } = await supabase
      .from('proxy_sessions').select('id', { count: 'exact', head: true })
      .eq('credential_id', id).eq('user_id', user.id).is('terminated_at', null)
    if ((count ?? 0) >= MAX_ACTIVE_SESSIONS) {
      return apiError(400, 'invalid_request', `A sub-user can have at most ${MAX_ACTIVE_SESSIONS} active sessions.`)
    }

    const { data, error } = await supabase.from('proxy_sessions').insert({
      credential_id: id, user_id: user.id, session_token: genSessionId(), label: label.value ?? 'Session',
    }).select('id, session_token, label, pinned, collapsed, created_at').single()
    if (error?.code === '23514') return apiError(400, 'invalid_request', error.message) // enforce_proxy_session_limits (0059)
    if (error || !data) {
      console.error('[v1 POST sessions] insert failed', error)
      return apiError(500, 'internal_error', 'Could not create the session.')
    }
    // The count above and the insert are separate statements, so two parallel
    // requests at 199 sessions could both pass. Re-count AFTER inserting and
    // back out if we went over (both may back out — a spurious 400 is fine,
    // an over-cap sub-user is not).
    const { count: after } = await supabase
      .from('proxy_sessions').select('id', { count: 'exact', head: true })
      .eq('credential_id', id).eq('user_id', user.id).is('terminated_at', null)
    if ((after ?? 0) > MAX_ACTIVE_SESSIONS) {
      await supabase.from('proxy_sessions').delete().eq('id', data.id)
      return apiError(400, 'invalid_request', `A sub-user can have at most ${MAX_ACTIVE_SESSIONS} active sessions.`)
    }
    return NextResponse.json(view(data, cred), { status: 201 })
  })
}
