import { createAdminClient } from '@/lib/supabase/server'

export type WebhookEvent = 'session_created' | 'bandwidth_threshold_crossed'

async function hmacHex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload))
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

type Endpoint = { id: string; url: string; secret: string }
type SupabaseAdmin = Awaited<ReturnType<typeof createAdminClient>>

// One delivery attempt, no retries — a failed delivery is recorded on the
// endpoint (last_failure_at/last_error) so the customer can see it and fix
// their receiver, rather than us queueing/backing off on their behalf.
// That's a deliberate v1 scope call, not an oversight: this is a
// notify-only feature (nothing downstream in GlobProxy depends on a
// webhook actually arriving), so the cost of "customer's endpoint was
// down for five minutes and missed one event" is low compared to the
// complexity of a real retry/backoff/dead-letter system. Worth revisiting
// if this becomes something integrations actually depend on.
async function deliverOne(
  supabase: SupabaseAdmin,
  ep: Endpoint,
  event: string,
  data: Record<string, unknown>
): Promise<{ ok: boolean; error?: string }> {
  const body = JSON.stringify({ event, created_at: new Date().toISOString(), data })
  try {
    const signature = await hmacHex(ep.secret, body)
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GlobProxy-Event': event,
        'X-GlobProxy-Signature': signature, // hex HMAC-SHA256 of the raw body, using the endpoint's secret
      },
      body,
      signal: AbortSignal.timeout(8000), // a slow/dead customer endpoint must not hang the request that triggered this
    })
    if (res.ok) {
      await supabase.from('webhook_endpoints')
        .update({ last_success_at: new Date().toISOString(), last_error: null })
        .eq('id', ep.id)
      return { ok: true }
    }
    const errMsg = `HTTP ${res.status}`
    await supabase.from('webhook_endpoints')
      .update({ last_failure_at: new Date().toISOString(), last_error: errMsg })
      .eq('id', ep.id)
    return { ok: false, error: errMsg }
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 500)
    // Deliberately NOT `.update(...).catch(() => {})` — Supabase query
    // builders aren't real Promises until awaited/thenable-resolved, so a
    // `.catch()` chained directly on the builder silently never runs (the
    // same anti-pattern flagged in the Passthrough and ScopeGov audits,
    // e.g. commit fa95fe0). This is already inside the outer catch, so a
    // second try/catch around the await is what's actually needed here.
    try {
      await supabase.from('webhook_endpoints')
        .update({ last_failure_at: new Date().toISOString(), last_error: msg })
        .eq('id', ep.id)
    } catch { /* best-effort status recording — the delivery itself already failed */ }
    return { ok: false, error: msg }
  }
}

// Fires `event` to every enabled endpoint the user has subscribed to it.
// ALWAYS awaited by the caller, never fire-and-forget — this stack runs on
// Cloudflare Workers, which kills any pending promise the instant a
// response is sent (the same constraint lib/bandwidth.ts and
// custom-worker.ts already document), so an un-awaited dispatch here would
// silently never complete. Never throws — a customer's unreachable or
// misconfigured endpoint must never break the request that triggered the
// event (session creation) or the cron batch it runs inside (bandwidth
// alerts), so every failure mode here is caught and recorded, not raised.
export async function dispatchWebhook(
  userId: string,
  event: WebhookEvent,
  data: Record<string, unknown>
): Promise<void> {
  const supabase = await createAdminClient()
  const { data: endpoints, error } = await supabase
    .from('webhook_endpoints')
    .select('id, url, secret')
    .eq('user_id', userId)
    .eq('enabled', true)
    .contains('event_types', [event])

  if (error) {
    console.error('[webhooks] failed to load endpoints for', userId, event, error)
    return
  }
  if (!endpoints?.length) return

  await Promise.all(endpoints.map((ep) => deliverOne(supabase, ep as Endpoint, event, data)))
}

// Sends a synthetic 'test' event to one endpoint regardless of its
// subscribed event_types (a 'test' delivery isn't a real subscribable
// event — it's not in the event_types CHECK constraint on purpose — so it
// bypasses the subscription filter dispatchWebhook() uses and goes
// straight to the one endpoint the caller already resolved ownership of).
export async function sendTestWebhook(
  userId: string,
  endpointId: string
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createAdminClient()
  const { data: ep, error } = await supabase
    .from('webhook_endpoints')
    .select('id, url, secret')
    .eq('id', endpointId)
    .eq('user_id', userId)
    .single()

  if (error || !ep) return { ok: false, error: 'Webhook not found' }

  return deliverOne(supabase, ep as Endpoint, 'test', {
    message: 'This is a test event from GlobProxy.',
  })
}
