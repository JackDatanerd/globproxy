import { withApiAuth, readJsonBody } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { parseLabel } from '@/lib/apiValidation'
import { isUuidString } from '@/lib/cursor'
import { NextResponse } from 'next/server'

// PATCH /api/v1/sub-users/:id/sessions/:sessionId  { label?, pinned?, collapsed?, terminate? }
export async function PATCH(req: Request, context: { params: Promise<{ id: string; sessionId: string }> }) {
  return withApiAuth(req, 'PATCH session', async ({ user, supabase }) => {
    const { id, sessionId } = await context.params
    // A malformed id would reach Postgres as 22P02 and come back as a 500.
    if (!isUuidString(id) || !isUuidString(sessionId)) return apiError(404, 'not_found', 'Session not found')
    const json = await readJsonBody(req)
    if (!json.ok) return json.response
    // `'label' in body` throws on a number/string/null body — that was a 500, not a 400.
    if (!json.body || typeof json.body !== 'object' || Array.isArray(json.body)) {
      return apiError(400, 'invalid_request', 'Request body must be a JSON object.')
    }
    const body = json.body as Record<string, unknown>

    const update: Record<string, unknown> = {}
    if ('label' in body) {
      const label = parseLabel(body.label)
      if (!label.ok) return apiError(400, 'invalid_request', label.error)
      update.label = label.value ?? 'Session'
    }
    if ('pinned' in body) {
      if (typeof body.pinned !== 'boolean') return apiError(400, 'invalid_request', 'pinned must be a boolean.')
      update.pinned = body.pinned
    }
    if ('collapsed' in body) {
      if (typeof body.collapsed !== 'boolean') return apiError(400, 'invalid_request', 'collapsed must be a boolean.')
      update.collapsed = body.collapsed
    }
    if ('terminate' in body) {
      // Termination is one-way (DELETE removes the session outright); a
      // `terminate: false` used to be silently ignored.
      if (body.terminate !== true) return apiError(400, 'invalid_request', 'terminate can only be true. A terminated session cannot be reactivated; create a new one.')
      update.terminated_at = new Date().toISOString()
    }
    if (Object.keys(update).length === 0) return apiError(400, 'invalid_request', 'No valid fields to update. Supported: label, pinned, collapsed, terminate.')

    const { data, error } = await supabase
      .from('proxy_sessions').update(update)
      .eq('id', sessionId).eq('credential_id', id).eq('user_id', user.id)
      .is('terminated_at', null) // a terminated session is gone: editing it used to return 200
      .select('id, label, pinned, collapsed, terminated_at, created_at').maybeSingle()
    if (error) {
      console.error('[v1 PATCH session] update failed', error)
      return apiError(500, 'internal_error', 'Could not update the session.')
    }
    if (!data) return apiError(404, 'not_found', 'Session not found')
    return NextResponse.json(data)
  })
}

// DELETE /api/v1/sub-users/:id/sessions/:sessionId
export async function DELETE(req: Request, context: { params: Promise<{ id: string; sessionId: string }> }) {
  return withApiAuth(req, 'DELETE session', async ({ user, supabase }) => {
    const { id, sessionId } = await context.params
    if (!isUuidString(id) || !isUuidString(sessionId)) return apiError(404, 'not_found', 'Session not found')
    const { data, error } = await supabase
      .from('proxy_sessions').delete()
      .eq('id', sessionId).eq('credential_id', id).eq('user_id', user.id).select('id')
    if (error) {
      console.error('[v1 DELETE session] failed', error)
      return apiError(500, 'internal_error', 'Could not delete the session.')
    }
    if (!data?.length) return apiError(404, 'not_found', 'Session not found')
    return NextResponse.json({ success: true })
  })
}
