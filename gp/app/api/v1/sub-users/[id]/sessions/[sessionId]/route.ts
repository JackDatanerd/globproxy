import { withApiAuth, readJsonBody } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { parseLabel } from '@/lib/apiValidation'
import { NextResponse } from 'next/server'

// PATCH /api/v1/sub-users/:id/sessions/:sessionId  { label?, pinned?, collapsed?, terminate? }
export async function PATCH(req: Request, context: { params: Promise<{ id: string; sessionId: string }> }) {
  return withApiAuth(req, 'PATCH session', async ({ user, supabase }) => {
    const { id, sessionId } = await context.params
    const json = await readJsonBody(req)
    if (!json.ok) return json.response
    const body = json.body ?? {}

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
    if (body.terminate === true) update.terminated_at = new Date().toISOString()
    if (Object.keys(update).length === 0) return apiError(400, 'invalid_request', 'No valid fields to update. Supported: label, pinned, collapsed, terminate.')

    const { data, error } = await supabase
      .from('proxy_sessions').update(update)
      .eq('id', sessionId).eq('credential_id', id).eq('user_id', user.id)
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
