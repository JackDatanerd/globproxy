import { createClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { sendTestWebhook } from '@/lib/webhooks'
import { NextResponse } from 'next/server'

// The URL on a webhook_endpoints row only has to pass the SSRF guard's
// private/loopback checks — it can point at any public https host,
// including one the user doesn't control. Without a limit here, "test"
// is otherwise an unthrottled way to make GlobProxy's server repeatedly
// POST to an arbitrary third-party URL. There's no rate-limit
// infrastructure yet (same gap noted for verify-payment), so this uses
// the endpoint's own last_success_at/last_failure_at — already updated
// on every delivery by deliverOne() — as a cheap per-endpoint cooldown
// instead of standing up a new table.
const TEST_COOLDOWN_MS = 10_000

export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended

  const { id } = await context.params

  const { data: ep } = await supabase
    .from('webhook_endpoints')
    .select('last_success_at, last_failure_at')
    .eq('id', id)
    .eq('user_id', user.id)
    .single()

  if (!ep) return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })

  const lastAttempt = [ep.last_success_at, ep.last_failure_at]
    .filter(Boolean)
    .map((t) => new Date(t as string).getTime())
    .sort((a, b) => b - a)[0]

  if (lastAttempt) {
    const elapsed = Date.now() - lastAttempt
    if (elapsed < TEST_COOLDOWN_MS) {
      const retryAfterSec = Math.ceil((TEST_COOLDOWN_MS - elapsed) / 1000)
      return NextResponse.json(
        { error: `Please wait ${retryAfterSec}s before sending another test` },
        { status: 429, headers: { 'Retry-After': String(retryAfterSec) } }
      )
    }
  }

  const result = await sendTestWebhook(user.id, id)

  if (!result.ok) return NextResponse.json({ error: result.error ?? 'Delivery failed' }, { status: 502 })
  return NextResponse.json({ success: true })
}
