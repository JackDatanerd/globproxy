import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { validateWebhookUrl } from '@/lib/ssrfGuard'
import { NextResponse } from 'next/server'

const ALLOWED_EVENTS = ['session_created', 'bandwidth_threshold_crossed'] as const

// Edits url / event_types / enabled on an endpoint the user owns.
// Ownership is enforced by scoping the update to .eq('user_id', user.id)
// rather than a RLS policy — see migration 0018's rationale: a URL change
// has to re-run the SSRF guard, which RLS can't do.
export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended

  const { id } = await context.params
  const body = await req.json().catch(() => ({}))

  const patch: Record<string, unknown> = {}

  if (body.url !== undefined) {
    const url = String(body.url).trim()
    const urlError = validateWebhookUrl(url)
    if (urlError) return NextResponse.json({ error: urlError }, { status: 400 })
    patch.url = url
  }

  if (body.event_types !== undefined) {
    const eventTypes = Array.isArray(body.event_types) ? body.event_types : []
    const cleanEvents = [...new Set(eventTypes)].filter(
      (e): e is string => typeof e === 'string' && (ALLOWED_EVENTS as readonly string[]).includes(e)
    )
    if (cleanEvents.length === 0) {
      return NextResponse.json({ error: `event_types must include at least one of: ${ALLOWED_EVENTS.join(', ')}` }, { status: 400 })
    }
    patch.event_types = cleanEvents
  }

  if (body.enabled !== undefined) {
    patch.enabled = Boolean(body.enabled)
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  const admin = await createAdminClient()
  const { data, error } = await admin
    .from('webhook_endpoints')
    .update(patch)
    .eq('id', id)
    .eq('user_id', user.id) // ownership check — this is what actually stops one user editing another's endpoint, not RLS
    .select('id, url, event_types, enabled, created_at, last_success_at, last_failure_at, last_error')
    .single()

  if (error) return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
  return NextResponse.json({ webhook: data })
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended

  const { id } = await context.params
  const admin = await createAdminClient()
  const { error, count } = await admin
    .from('webhook_endpoints')
    .delete({ count: 'exact' })
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!count) return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
  return NextResponse.json({ success: true })
}
