import { createClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { sendTestWebhook } from '@/lib/webhooks'
import { NextResponse } from 'next/server'

// Sends a signed `test` event to one endpoint. The per-account 10s cooldown
// (so "test" can't be used as an unthrottled way to make our server POST to
// an arbitrary third-party URL) lives in sendTestWebhook(): it counts only
// earlier TEST deliveries now. It used to key off last_success_at /
// last_failure_at, which every real delivery also moves — so a busy
// endpoint could not be tested at all — and it was a read-then-act race.
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended

  const { id } = await context.params
  const result = await sendTestWebhook(user.id, id)

  if (result.cooldown) {
    return NextResponse.json({ error: result.error }, { status: 429, headers: { 'Retry-After': '10' } })
  }
  if (result.error === 'Webhook not found') return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })
  if (!result.ok) return NextResponse.json({ error: result.error ?? 'Delivery failed' }, { status: 502 })
  return NextResponse.json({ success: true })
}
