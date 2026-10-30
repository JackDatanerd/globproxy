import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, isUuid, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'

const ACTIONS = ['close', 'reopen', 'pending', 'assign', 'unassign', 'mark_read', 'mark_unread'] as const
type Action = typeof ACTIONS[number]

// POST { threadId, action, assignTo? } — everything staff do to a conversation that is not a reply.
//   close / reopen / pending   status (conditional on the current status, so two admins cannot
//                              both close the same conversation and a stale tab cannot reopen one)
//   assign { assignTo }        an administrator's id, or 'me'
//   unassign
//   mark_read / mark_unread    the unread flag (opening a thread marks it read)
export async function POST(req: Request) {
  // Marking a conversation read/unread happens just by opening it; it must not demand a fresh 2FA code.
  const peek = await req.clone().json().catch(() => null) as { action?: unknown } | null
  const light = peek?.action === 'mark_read' || peek?.action === 'mark_unread'
  const auth = await authorizeAdmin(req, { mfaOnly: light })
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ threadId?: unknown; action?: unknown; assignTo?: unknown }>(req)
  if (!body || !isUuid(body.threadId)) return badRequest('Thread ID missing or invalid')
  const action = body.action as Action
  if (!ACTIONS.includes(action)) return badRequest(`action must be one of: ${ACTIONS.join(', ')}`)

  const { data: thread, error: tErr } = await supabase.from('inbox_threads')
    .select('id, status, ticket_no, customer_user_id').eq('id', body.threadId).maybeSingle()
  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 })
  if (!thread) return NextResponse.json({ error: 'This conversation no longer exists.' }, { status: 404 })

  let patch: Record<string, unknown> = {}
  let from: string | null = null  // required current status for a status change
  switch (action) {
    case 'close':   patch = { status: 'closed', unread: false }; break
    case 'reopen':  patch = { status: 'open' }; from = 'closed'; break
    case 'pending': patch = { status: 'pending' }; break
    case 'mark_read':   patch = { unread: false }; break
    case 'mark_unread': patch = { unread: true }; break
    case 'unassign': patch = { assigned_to: null }; break
    case 'assign': {
      const target = body.assignTo === 'me' ? adminId : body.assignTo
      if (!isUuid(target)) return badRequest('Choose an administrator to assign this to.')
      const { data: who } = await supabase.from('profiles').select('role').eq('id', target).maybeSingle()
      if (who?.role !== 'admin') return badRequest('Conversations can only be assigned to administrators.')
      patch = { assigned_to: target }
      break
    }
  }
  if (action === 'close' && thread.status === 'closed') return NextResponse.json({ error: 'This conversation is already closed.' }, { status: 409 })

  let q = supabase.from('inbox_threads').update(patch).eq('id', thread.id)
  if (from) q = q.eq('status', from)
  const { data: updated, error } = await q.select('id')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!updated?.length) return NextResponse.json({ error: 'This conversation is not closed (someone may have just changed it).' }, { status: 409 })

  if (action !== 'mark_read' && action !== 'mark_unread') {
    await logAdminAction(supabase, {
      adminId, action: `inbox.${action}`, targetUserId: thread.customer_user_id ?? null, targetRef: thread.id,
      details: { ticket: thread.ticket_no, ...(action === 'assign' ? { assigned_to: patch.assigned_to } : {}) },
    })
  }
  return NextResponse.json({ success: true })
}
