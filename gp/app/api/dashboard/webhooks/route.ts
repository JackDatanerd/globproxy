import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { validateWebhookUrl } from '@/lib/ssrfGuard'
import { NextResponse } from 'next/server'

const ALLOWED_EVENTS = ['session_created', 'bandwidth_threshold_crossed'] as const

// List this user's webhook endpoints. `secret` is never selected here —
// only the create response ever returns it, once.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('webhook_endpoints')
    .select('id, url, event_types, enabled, created_at, last_success_at, last_failure_at, last_error')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ webhooks: data })
}

function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
  return `whsec_${hex}`
}

// Create a new endpoint. The plaintext secret is returned exactly once,
// in this response only — see migration 0018 for why it can't be a
// one-way hash like api_keys.
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended

  const body = await req.json().catch(() => ({}))
  const url = String(body?.url ?? '').trim()
  const eventTypes = Array.isArray(body?.event_types) ? body.event_types : []

  const urlError = validateWebhookUrl(url)
  if (urlError) return NextResponse.json({ error: urlError }, { status: 400 })

  const cleanEvents = [...new Set(eventTypes)].filter(
    (e): e is string => typeof e === 'string' && (ALLOWED_EVENTS as readonly string[]).includes(e)
  )
  if (cleanEvents.length === 0) {
    return NextResponse.json({ error: `event_types must include at least one of: ${ALLOWED_EVENTS.join(', ')}` }, { status: 400 })
  }

  const { count } = await supabase
    .from('webhook_endpoints')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id)
  if ((count ?? 0) >= 10) {
    return NextResponse.json({ error: 'Maximum of 10 webhook endpoints per account' }, { status: 400 })
  }

  const secret = generateSecret()
  const admin = await createAdminClient()
  const { data, error } = await admin
    .from('webhook_endpoints')
    .insert({ user_id: user.id, url, event_types: cleanEvents, secret })
    .select('id, url, event_types, enabled, created_at, secret')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ webhook: data })
}
