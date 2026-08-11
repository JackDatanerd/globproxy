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
// last_success_at/last_failure_at — already updated on every delivery by
// deliverOne() — as a cheap cooldown instead of standing up a new table.
//
// Scoped to the ACCOUNT (max last-attempt across every endpoint this user
// owns), not to the single endpoint row being tested. An earlier version
// keyed the cooldown per-row, which an account could bypass by creating
// several endpoints that all point at the same URL (endpoint creation
// has no URL-uniqueness constraint) and round-robining test calls across
// them, each with its own untouched cooldown clock. Checking the max
// across all rows means every test call from an account shares one
// clock, however many endpoints it has.
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
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .single()

  if (!ep) return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })

  const { data: accountEndpoints } = await supabase
    .from('webhook_endpoints')
    .select('last_success_at, last_failure_at')
    .eq('user_id', user.id)

  const lastAttempt = (accountEndpoints ?? [])
    .flatMap((row) => [row.last_success_at, row.last_failure_at])
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
