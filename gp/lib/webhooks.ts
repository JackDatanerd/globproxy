import { appUrl } from '@/lib/appUrl'
import { createAdminClient } from '@/lib/supabase/server'
import { validateWebhookUrl, checkHostnameResolution } from '@/lib/ssrfGuard'
import { sendEmail, escapeHtml } from '@/lib/email'
import type { WebhookEvent } from '@/lib/webhookEvents'

export type { WebhookEvent } from '@/lib/webhookEvents'

// ── Delivery model ────────────────────────────────────────────────────
// Every (event, endpoint) pair gets a webhook_deliveries row holding the
// exact JSON body that is signed. The first attempt runs inline (callers
// await dispatchWebhook — Workers kills un-awaited promises), and a failed
// attempt is retried by the 'webhooks' cron task (runWebhookRetries) with
// backoff: 1m, 5m, 30m, 2h, 6h, then the delivery is marked failed.
// After DISABLE_THRESHOLD consecutive failed attempts the endpoint is
// disabled and its owner emailed; a 410 Gone disables it immediately.
//
// Receivers should treat delivery as at-least-once and de-duplicate on the
// event `id` (also sent as X-GlobProxy-Event-Id).
const MAX_ATTEMPTS = 6
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000] // after attempt 1..5
const DISABLE_THRESHOLD = 50
const REQUEST_TIMEOUT_MS = 8000
const RETRIES_PER_RUN = 8 // Workers caps subrequests per invocation — keep each cron tick small
const CLAIM_LEASE_MS = 5 * 60_000
const TEST_COOLDOWN_MS = 10_000

type SupabaseAdmin = Awaited<ReturnType<typeof createAdminClient>>
type Endpoint = { id: string; user_id: string; url: string; secret: string }
type Delivery = { id: string; endpoint_id: string; user_id: string; event_id: string; event_type: string; payload: string; attempts: number }
type AttemptResult = { ok: boolean; error?: string; status?: number; deliveryId?: string }

async function hmacHex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload))
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Two signatures, so existing receivers keep working and new ones can opt
// into replay protection:
//   X-GlobProxy-Signature     hex HMAC-SHA256(secret, body)             (legacy, unchanged)
//   X-GlobProxy-Signature-V2  t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${body}`)>
// Reject V2 deliveries whose timestamp is more than ~5 minutes old.
export async function signatureHeaders(secret: string, body: string): Promise<Record<string, string>> {
  const t = Math.floor(Date.now() / 1000)
  return {
    'X-GlobProxy-Signature': await hmacHex(secret, body),
    'X-GlobProxy-Signature-V2': `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)}`,
    'X-GlobProxy-Timestamp': String(t),
  }
}

function nextAttemptAt(attemptsDone: number): string | null {
  const delay = RETRY_DELAYS_MS[attemptsDone - 1]
  return delay === undefined ? null : new Date(Date.now() + delay).toISOString()
}

async function notifyAutoDisabled(supabase: SupabaseAdmin, ep: Endpoint) {
  try {
    const { data: profile } = await supabase.from('profiles').select('email, full_name').eq('id', ep.user_id).single()
    if (!profile?.email) return
    const { data: row } = await supabase.from('webhook_endpoints').select('disabled_reason, url').eq('id', ep.id).single()
    await sendEmail({
      to: profile.email,
      subject: 'A GlobProxy webhook endpoint was disabled',
      html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;">
        <h2>Webhook endpoint disabled</h2>
        <p>Hi ${escapeHtml(profile.full_name?.split(' ')[0]) || 'there'}, we turned off this webhook endpoint:</p>
        <p><code>${escapeHtml(row?.url ?? ep.url)}</code></p>
        <p>Reason: ${escapeHtml(row?.disabled_reason ?? 'repeated delivery failures')}.</p>
        <p>Fix your receiver, then re-enable it in
        <a href="${appUrl()}/dashboard/settings">Settings → Webhooks</a>.
        Failed deliveries are kept for 14 days and can be redelivered from there.</p></div>`,
    })
  } catch (e) {
    console.error('[webhooks] auto-disable notification failed', ep.id, e)
  }
}

// One attempt against one endpoint for one stored delivery; records the
// outcome on both the delivery row and the endpoint. Never throws.
async function attemptDelivery(
  supabase: SupabaseAdmin,
  ep: Endpoint,
  d: Delivery,
  opts: { retry: boolean }
): Promise<AttemptResult> {
  const started = Date.now()
  const attempts = d.attempts + 1
  let ok = false
  let status: number | undefined
  let error: string | undefined
  let permanent = false
  let forceDisable: string | null = null

  try {
    // Re-validated at every delivery, not just at save time: the URL may
    // have been edited via a direct DB path, and DNS can change.
    const guardErr = validateWebhookUrl(ep.url) ?? (await checkHostnameResolution(new URL(ep.url).hostname))
    if (guardErr) {
      error = guardErr
      permanent = true
      forceDisable = guardErr
    } else {
      const res = await fetch(ep.url, {
        method: 'POST',
        // 'manual': a public https host must not be able to bounce our
        // server to an internal address; any redirect is a failed delivery.
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'GlobProxy-Webhooks/1.0',
          'X-GlobProxy-Event': d.event_type,
          'X-GlobProxy-Event-Id': d.event_id,
          'X-GlobProxy-Delivery': d.id,
          ...(await signatureHeaders(ep.secret, d.payload)),
        },
        body: d.payload,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      status = res.type === 'opaqueredirect' ? 302 : res.status
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        error = 'Endpoint returned a redirect — redirects are not followed for webhook deliveries'
        permanent = true // retrying a redirect can never succeed
      } else if (res.ok) {
        ok = true
      } else if (res.status === 410) {
        error = 'HTTP 410'
        permanent = true
        forceDisable = 'Endpoint returned 410 Gone'
      } else {
        error = `HTTP ${res.status}`
      }
    }
  } catch (e: any) {
    error = String(e?.message ?? e).slice(0, 500)
  }

  const willRetry = !ok && !permanent && opts.retry && attempts < MAX_ATTEMPTS
  const patch: Record<string, unknown> = {
    attempts,
    last_attempt_at: new Date().toISOString(),
    response_status: status ?? null,
    last_error: ok ? null : error ?? null,
    duration_ms: Date.now() - started,
    status: ok ? 'succeeded' : willRetry ? 'retrying' : 'failed',
    next_attempt_at: willRetry ? nextAttemptAt(attempts) : null,
  }
  try {
    await supabase.from('webhook_deliveries').update(patch).eq('id', d.id)
  } catch (e) {
    console.error('[webhooks] failed to record delivery result', d.id, e)
  }

  try {
    const { data: justDisabled } = await supabase.rpc('record_webhook_attempt', {
      p_endpoint_id: ep.id,
      p_ok: ok,
      p_error: error ?? '',
      p_disable_threshold: DISABLE_THRESHOLD,
      p_force_disable_reason: forceDisable,
    })
    if (justDisabled === true) await notifyAutoDisabled(supabase, ep)
  } catch (e) {
    console.error('[webhooks] failed to record endpoint attempt', ep.id, e)
  }

  return { ok, error, status, deliveryId: d.id }
}

// Fires `event` to every enabled endpoint the user subscribed to it.
// ALWAYS awaited by the caller (Workers kills pending promises once the
// response is sent). Never throws — a customer's broken endpoint must never
// fail the request or cron batch that triggered the event.
export async function dispatchWebhook(
  userId: string,
  event: WebhookEvent,
  data: Record<string, unknown>
): Promise<void> {
  try {
    const supabase = await createAdminClient()
    const { data: endpoints, error } = await supabase
      .from('webhook_endpoints')
      .select('id, user_id, url, secret')
      .eq('user_id', userId)
      .eq('enabled', true)
      .contains('event_types', [event])

    if (error) {
      console.error('[webhooks] failed to load endpoints for', userId, event, error)
      return
    }
    if (!endpoints?.length) return

    const eventId = crypto.randomUUID()
    const payload = JSON.stringify({ id: eventId, event, created_at: new Date().toISOString(), data })

    await Promise.all(
      (endpoints as Endpoint[]).map(async (ep) => {
        // Inserted as 'retrying' due in 2 minutes: if this Worker dies
        // between insert and first attempt, the retry task still picks it up.
        const { data: row, error: insErr } = await supabase
          .from('webhook_deliveries')
          .insert({
            endpoint_id: ep.id, user_id: userId, event_id: eventId, event_type: event, payload,
            status: 'retrying', attempts: 0, next_attempt_at: new Date(Date.now() + 2 * 60_000).toISOString(),
          })
          .select('id, endpoint_id, user_id, event_id, event_type, payload, attempts')
          .single()
        if (insErr || !row) {
          console.error('[webhooks] failed to persist delivery', ep.id, insErr)
          return
        }
        await attemptDelivery(supabase, ep, row as Delivery, { retry: true })
      })
    )
  } catch (e) {
    console.error('[webhooks] dispatch failed', userId, event, e)
  }
}

// Synthetic 'test' event to one endpoint, regardless of its subscriptions.
// The 10s cooldown is per account and counts only earlier TEST deliveries —
// it used to key off last_success_at, which real traffic also moves, so a
// busy endpoint could not be tested at all.
export async function sendTestWebhook(
  userId: string,
  endpointId: string
): Promise<AttemptResult & { cooldown?: boolean }> {
  const supabase = await createAdminClient()
  const { data: ep } = await supabase
    .from('webhook_endpoints').select('id, user_id, url, secret')
    .eq('id', endpointId).eq('user_id', userId).single()
  if (!ep) return { ok: false, error: 'Webhook not found' }

  const since = new Date(Date.now() - TEST_COOLDOWN_MS).toISOString()
  const { count } = await supabase
    .from('webhook_deliveries').select('id', { count: 'exact', head: true })
    .eq('user_id', userId).eq('event_type', 'test').gte('created_at', since)
  if ((count ?? 0) > 0) return { ok: false, error: 'Please wait a few seconds before sending another test.', cooldown: true }

  const eventId = crypto.randomUUID()
  const payload = JSON.stringify({
    id: eventId, event: 'test', created_at: new Date().toISOString(),
    data: { message: 'This is a test event from GlobProxy.' },
  })
  const { data: row, error } = await supabase
    .from('webhook_deliveries')
    .insert({ endpoint_id: ep.id, user_id: userId, event_id: eventId, event_type: 'test', payload, status: 'failed', attempts: 0 })
    .select('id, endpoint_id, user_id, event_id, event_type, payload, attempts').single()
  if (error || !row) return { ok: false, error: 'Could not record the test delivery' }

  return attemptDelivery(supabase, ep as Endpoint, row as Delivery, { retry: false })
}

// Manual re-send of a stored delivery (same event id + body, fresh
// signature timestamp). One attempt, no automatic retries.
export async function redeliverWebhook(userId: string, deliveryId: string, endpointId?: string): Promise<AttemptResult> {
  const supabase = await createAdminClient()
  const { data: d } = await supabase
    .from('webhook_deliveries')
    .select('id, endpoint_id, user_id, event_id, event_type, payload, attempts')
    .eq('id', deliveryId).eq('user_id', userId).single()
  if (!d || (endpointId && d.endpoint_id !== endpointId)) return { ok: false, error: 'Delivery not found' }
  const { data: ep } = await supabase
    .from('webhook_endpoints').select('id, user_id, url, secret')
    .eq('id', d.endpoint_id).eq('user_id', userId).single()
  if (!ep) return { ok: false, error: 'Webhook not found' }
  return attemptDelivery(supabase, ep as Endpoint, d as Delivery, { retry: false })
}

// Cron: retry due deliveries. Each is claimed with a lease first so two
// overlapping runs can't double-send.
export async function runWebhookRetries(limit = RETRIES_PER_RUN) {
  const supabase = await createAdminClient()
  const nowIso = new Date().toISOString()
  const { data: due, error } = await supabase
    .from('webhook_deliveries')
    .select('id, endpoint_id, user_id, event_id, event_type, payload, attempts')
    .eq('status', 'retrying')
    .lte('next_attempt_at', nowIso)
    .order('next_attempt_at', { ascending: true })
    .limit(limit)
  if (error) {
    console.error('[webhooks] failed to load due deliveries', error)
    return { due: 0, retried: 0, succeeded: 0 }
  }

  let retried = 0
  let succeeded = 0
  for (const d of (due ?? []) as Delivery[]) {
    const { data: claimed } = await supabase
      .from('webhook_deliveries')
      .update({ next_attempt_at: new Date(Date.now() + CLAIM_LEASE_MS).toISOString() })
      .eq('id', d.id).eq('status', 'retrying').lte('next_attempt_at', nowIso)
      .select('id')
    if (!claimed?.length) continue

    const { data: ep } = await supabase
      .from('webhook_endpoints').select('id, user_id, url, secret, enabled').eq('id', d.endpoint_id).single()
    if (!ep || !ep.enabled) {
      await supabase.from('webhook_deliveries')
        .update({ status: 'failed', next_attempt_at: null, last_error: 'Endpoint disabled or deleted before delivery' })
        .eq('id', d.id)
      continue
    }
    const r = await attemptDelivery(supabase, ep as Endpoint, d, { retry: true })
    retried++
    if (r.ok) succeeded++
  }
  return { due: due?.length ?? 0, retried, succeeded }
}

// Cron (every 5 min): bandwidth-threshold webhooks. Previously fired from
// the once-a-day email run, so a customer crossing 95% at 9am heard about it
// at 8am the next day. Own de-dupe flags (wh_alerted_*), independent of the
// email flags; only accounts that actually have a subscribed endpoint are
// scanned. Highest newly-crossed level fires once; lower levels are marked
// so they don't fire afterwards. Flags clear when usage drops below 80%.
export async function runBandwidthThresholdWebhooks() {
  const supabase = await createAdminClient()
  const { data: eps, error } = await supabase
    .from('webhook_endpoints').select('user_id')
    .eq('enabled', true)
    .overlaps('event_types', ['bandwidth_threshold_crossed', 'bandwidth_exhausted'])
  if (error) { console.error('[webhooks] threshold scan failed', error); return { fired: 0 } }
  const userIds = [...new Set((eps ?? []).map((e) => e.user_id as string))]
  if (!userIds.length) return { fired: 0 }

  const { data: accounts } = await supabase
    .from('bandwidth_accounts')
    .select('user_id, total_gb, available_gb, wh_alerted_80_at, wh_alerted_95_at, wh_alerted_100_at')
    .in('user_id', userIds)
    .gt('total_gb', 0)

  let fired = 0
  const nowIso = new Date().toISOString()
  for (const acc of accounts ?? []) {
    const total = Number(acc.total_gb)
    const avail = Number(acc.available_gb)
    const pct = ((total - avail) / total) * 100

    if (pct < 80) {
      if (acc.wh_alerted_80_at || acc.wh_alerted_95_at || acc.wh_alerted_100_at) {
        await supabase.from('bandwidth_accounts')
          .update({ wh_alerted_80_at: null, wh_alerted_95_at: null, wh_alerted_100_at: null })
          .eq('user_id', acc.user_id)
      }
      continue
    }

    const level = avail <= 0 || pct >= 100 ? 100 : pct >= 95 ? 95 : 80
    const already = level === 100 ? acc.wh_alerted_100_at : level === 95 ? acc.wh_alerted_95_at : acc.wh_alerted_80_at
    if (already) continue

    // Claim before sending (flag first, then deliver): a duplicate webhook
    // is worse than the rare lost one, and the delivery itself is retried.
    const flags: Record<string, string> = { wh_alerted_80_at: nowIso }
    if (level >= 95) flags.wh_alerted_95_at = nowIso
    if (level === 100) flags.wh_alerted_100_at = nowIso
    const { error: flagErr } = await supabase.from('bandwidth_accounts').update(flags).eq('user_id', acc.user_id)
    if (flagErr) { console.error('[webhooks] failed to set threshold flag', acc.user_id, flagErr); continue }

    if (level === 100) {
      await dispatchWebhook(acc.user_id, 'bandwidth_exhausted', { used_pct: pct, available_gb: avail, total_gb: total })
    } else {
      await dispatchWebhook(acc.user_id, 'bandwidth_threshold_crossed', {
        threshold_pct: level, used_pct: pct, available_gb: avail, total_gb: total,
      })
    }
    fired++
  }
  return { fired }
}

// Cron cleanup: delivery log older than 14 days, idempotency keys older than 24h.
export async function pruneIntegrationData() {
  const supabase = await createAdminClient()
  const dayAgo = new Date(Date.now() - 24 * 3_600_000).toISOString()
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 3_600_000).toISOString()
  const a = await supabase.from('webhook_deliveries').delete().lt('created_at', twoWeeksAgo).neq('status', 'retrying')
  const b = await supabase.from('api_idempotency_keys').delete().lt('created_at', dayAgo)
  if (a.error) console.error('[webhooks] delivery prune failed', a.error)
  if (b.error) console.error('[webhooks] idempotency prune failed', b.error)
  return { deliveries_pruned: !a.error, idempotency_pruned: !b.error }
}
