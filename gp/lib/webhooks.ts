import { getCloudflareContext } from '@opennextjs/cloudflare'
import { appUrl } from '@/lib/appUrl'
import { createAdminClient } from '@/lib/supabase/server'
import { validateWebhookUrl, validateWebhookPort, checkHostnameResolution } from '@/lib/ssrfGuard'
import { sendEmail, escapeHtml } from '@/lib/email'
import { fetchAllRows } from '@/lib/dbPaging'
import { IDEMPOTENCY_WINDOW_MS } from '@/lib/idempotency'
import { WEBHOOK_API_VERSION, WEBHOOK_WILDCARD, subscribesTo, type WebhookEvent } from '@/lib/webhookEvents'

export type { WebhookEvent } from '@/lib/webhookEvents'

// ── Delivery model ────────────────────────────────────────────────────
// Every (event, endpoint) pair gets a webhook_deliveries row holding the
// exact JSON body that is signed. The first attempt runs right after the
// request that caused the event (ctx.waitUntil — see runInBackground — so a
// receiver's slowness never delays the caller's own response), and a failed
// attempt is retried by the 'webhooks' cron task (runWebhookRetries) with
// backoff: 1m, 5m, 30m, 2h, 6h, then the delivery is marked failed.
// After DISABLE_THRESHOLD consecutive failed attempts AND a failing streak more than
// 24 hours old (record_webhook_attempt, migration 0089) the endpoint is disabled and
// its owner emailed; a 410 Gone disables it immediately.
//
// Receivers should treat delivery as at-least-once and de-duplicate on the
// event `id` (also sent as X-GlobProxy-Event-Id).
const MAX_ATTEMPTS = 6
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000] // after attempt 1..5
const DISABLE_THRESHOLD = 50
const REQUEST_TIMEOUT_MS = 8000
// Workers caps subrequests per invocation, so a tick is bounded — but the bound
// is generous enough that the deferred first attempts (usage sync, auto top-up)
// plus retries clear within a tick or two. ~6 subrequests per delivery.
// Every deferred event (usage alerts, auto top-up, the revoke-all batch) waits for this task, and the
// task runs once per 5-minute tick. At 24 a tick / 3 per endpoint, revoking 25 keys took ~45 minutes to
// reach a receiver and a burst of session_low events took hours. The caps are sized for a burst to clear
// in a tick or two; a DEAD endpoint still cannot burn the budget because a group stops after
// GROUP_STOP_AFTER_FAILURES consecutive failures (its remaining rows stay due for the next tick).
const RETRIES_PER_RUN = 60
const PER_ENDPOINT_PER_RUN = 12
const GROUP_STOP_AFTER_FAILURES = 2
const ENDPOINT_PARALLELISM = 6   // endpoints worked at once; one endpoint's deliveries stay sequential
const CLAIM_LEASE_MS = 5 * 60_000
const TEST_COOLDOWN_MS = 10_000

type SupabaseAdmin = Awaited<ReturnType<typeof createAdminClient>>
type Endpoint = {
  id: string; user_id: string; url: string; secret: string; event_types?: string[]
  // Set for a limited time after a secret rotation (see rotateSecret).
  previous_secret?: string | null; previous_secret_expires_at?: string | null
}
type Delivery = {
  id: string; endpoint_id: string; user_id: string; event_id: string; event_type: string; payload: string; attempts: number
  status?: string
}
type AttemptResult = { ok: boolean; error?: string; status?: number; deliveryId?: string }

const EP_COLS = 'id, user_id, url, secret, event_types, previous_secret, previous_secret_expires_at'
const DELIVERY_COLS = 'id, endpoint_id, user_id, event_id, event_type, payload, attempts, status'
const RESPONSE_SNIPPET_CHARS = 500

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
//
// During a secret-rotation grace window a third header carries the SAME V2
// signature made with the PREVIOUS secret, so a receiver still holding the old
// secret can verify while the new one is rolled out:
//   X-GlobProxy-Signature-V2-Previous  t=<unix seconds>,v1=<hex HMAC with the previous secret>
export async function signatureHeaders(secret: string, body: string, previousSecret?: string | null): Promise<Record<string, string>> {
  const t = Math.floor(Date.now() / 1000)
  const headers: Record<string, string> = {
    'X-GlobProxy-Signature': await hmacHex(secret, body),
    'X-GlobProxy-Signature-V2': `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)}`,
    'X-GlobProxy-Timestamp': String(t),
  }
  if (previousSecret) headers['X-GlobProxy-Signature-V2-Previous'] = `t=${t},v1=${await hmacHex(previousSecret, `${t}.${body}`)}`
  return headers
}

// First bytes of the receiver's response, for the delivery log ("why did you
// 400 me?"). Bounded read — a hostile endpoint streaming gigabytes can't make
// us buffer it — and the body is always cancelled so the connection is freed.
async function readSnippet(res: Response): Promise<string | null> {
  try {
    if (!res.body) return null
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (total < RESPONSE_SNIPPET_CHARS * 4) {
      const { done, value } = await reader.read()
      if (done || !value) break
      chunks.push(value)
      total += value.byteLength
    }
    await reader.cancel().catch(() => {})
    const bytes = new Uint8Array(total)
    let off = 0
    for (const c of chunks) { bytes.set(c, off); off += c.byteLength }
    // eslint-disable-next-line no-control-regex
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    return text.slice(0, RESPONSE_SNIPPET_CHARS) || null
  } catch {
    return null
  }
}

function nextAttemptAt(attemptsDone: number): string | null {
  const delay = RETRY_DELAYS_MS[attemptsDone - 1]
  return delay === undefined ? null : new Date(Date.now() + delay).toISOString()
}

async function notifyAutoDisabled(supabase: SupabaseAdmin, ep: Endpoint) {
  // Tell the account's OTHER endpoints first (the disabled one is already switched
  // off, so the lookup skips it): an integration with a second receiver can then
  // alert someone, which the e-mail below cannot do for a machine.
  try {
    const { data: gone } = await supabase.from('webhook_endpoints').select('disabled_reason, url').eq('id', ep.id).maybeSingle()
    await dispatchWebhook(ep.user_id, 'webhook_endpoint_disabled', {
      webhook_id: ep.id, url: gone?.url ?? ep.url, reason: gone?.disabled_reason ?? 'repeated delivery failures',
    }, { defer: true })
  } catch (e) {
    console.error('[webhooks] webhook_endpoint_disabled dispatch failed', ep.id, e)
  }
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

// Runs `work` after the response is sent when we are inside a Workers
// invocation (ctx.waitUntil keeps it alive); returns false outside one (local
// dev, scripts) so the caller awaits it instead. Used for first delivery
// attempts: they used to run inline, so one slow receiver (8 s timeout + DNS)
// stalled the customer's own API call — and a 10-item bulk create or a
// 20-item bulk top-up serialised that into minutes.
function runInBackground(work: Promise<unknown>): boolean {
  const safe = work.then(() => {}, (e) => console.error('[webhooks] background delivery failed', e))
  try {
    getCloudflareContext({ async: false }).ctx.waitUntil(safe)
    return true
  } catch {
    return false
  }
}

// An endpoint that was just auto-disabled can never deliver its queued retries.
// Failing them in one statement stops them occupying retry slots (and the
// delivery log keeps the reason) instead of each being claimed and failed one
// by one over the following ticks.
async function failPendingDeliveries(supabase: SupabaseAdmin, endpointId: string, reason: string) {
  const { error } = await supabase.from('webhook_deliveries')
    .update({ status: 'failed', next_attempt_at: null, last_error: reason })
    .eq('endpoint_id', endpointId).eq('status', 'retrying')
  if (error) console.error('[webhooks] failed to fail pending deliveries', endpointId, error)
}

// One attempt against one endpoint for one stored delivery; records the
// outcome on both the delivery row and the endpoint. Never throws.
async function attemptDelivery(
  supabase: SupabaseAdmin,
  ep: Endpoint,
  d: Delivery,
  opts: { retry: boolean; manual?: boolean }
): Promise<AttemptResult> {
  const started = Date.now()
  const attempts = d.attempts + 1
  let ok = false
  let status: number | undefined
  let error: string | undefined
  let permanent = false
  let forceDisable: string | null = null
  let responseBody: string | null = null
  const previousActive = !!ep.previous_secret && !!ep.previous_secret_expires_at && new Date(ep.previous_secret_expires_at).getTime() > Date.now()

  try {
    // Re-validated at every delivery, not just at save time: the URL may
    // have been edited via a direct DB path, and DNS can change.
    // The port rule is enforced here too: an endpoint saved before it existed
    // would otherwise keep making our server connect to arbitrary ports.
    const guardErr =
      validateWebhookUrl(ep.url) ??
      validateWebhookPort(new URL(ep.url)) ??
      (await checkHostnameResolution(new URL(ep.url).hostname))
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
          ...(await signatureHeaders(ep.secret, d.payload, previousActive ? ep.previous_secret : null)),
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
      // Always drain/cancel the body (frees the connection); keep a snippet.
      responseBody = res.type === 'opaqueredirect' ? null : await readSnippet(res)
    }
  } catch (e: any) {
    // Deliberately generic: the raw message distinguishes "connection refused"
    // from "no route" from "TLS failure", which would let an endpoint URL be
    // used as a port/host probe from our egress IP and read back through the
    // delivery log.
    error = e?.name === 'TimeoutError' || e?.name === 'AbortError'
      ? `Timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
      : 'Could not connect to the endpoint'
  }

  const willRetry = !ok && !permanent && opts.retry && attempts < MAX_ATTEMPTS
  const patch: Record<string, unknown> = {
    attempts,
    last_attempt_at: new Date().toISOString(),
    response_status: status ?? null,
    response_body: responseBody,
    last_error: ok ? null : error ?? null,
    duration_ms: Date.now() - started,
    status: ok ? 'succeeded' : willRetry ? 'retrying' : 'failed',
    next_attempt_at: willRetry ? nextAttemptAt(attempts) : null,
  }
  // A manual redelivery of a delivery that is still waiting on its automatic
  // retries must not cancel them when it fails: record what happened, but
  // leave the retry schedule (status / next_attempt_at / attempt count) alone.
  if (opts.manual && !ok && d.status === 'retrying') {
    delete patch.status
    delete patch.next_attempt_at
    delete patch.attempts
  }
  // supabase-js reports a failed write as { error }, it does not throw — so a bare
  // try/catch here recorded nothing and said nothing: a delivery that SUCCEEDED
  // stayed 'retrying' and was sent again. Checked, retried once, and logged.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { error: recErr } = await supabase.from('webhook_deliveries').update(patch).eq('id', d.id)
      if (!recErr) break
      console.error('[webhooks] failed to record delivery result', d.id, attempt === 0 ? '(retrying)' : '(giving up)', recErr.message)
    } catch (e) {
      console.error('[webhooks] failed to record delivery result', d.id, e)
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 250))
  }

  try {
    const { data: justDisabled } = await supabase.rpc('record_webhook_attempt', {
      p_endpoint_id: ep.id,
      p_ok: ok,
      p_error: error ?? '',
      p_disable_threshold: DISABLE_THRESHOLD,
      p_force_disable_reason: forceDisable,
    })
    if (justDisabled === true) {
      await failPendingDeliveries(supabase, ep.id, 'Endpoint was disabled after repeated failures')
      await notifyAutoDisabled(supabase, ep)
    }
  } catch (e) {
    console.error('[webhooks] failed to record endpoint attempt', ep.id, e)
  }

  return { ok, error, status, deliveryId: d.id }
}

// Fires `event` to every enabled endpoint the user subscribed to it.
// Callers still await it (the deliveries are persisted before it returns); the
// first HTTP attempts then continue in the background. Never throws — a customer's broken endpoint must never
// fail the request or cron batch that triggered the event.
//
// `defer: true` persists the delivery as due-now and returns WITHOUT making
// the first HTTP attempt; the 'webhooks' cron task delivers it moments later.
// Cron-driven callers (usage sync, auto top-up) use this: the first attempt
// otherwise runs inline with an 8 s timeout, which let one customer's slow
// endpoint stall the usage sync for every other customer.
export async function dispatchWebhook(
  userId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
  opts: { defer?: boolean; skipIfSubscribedTo?: WebhookEvent } = {}
): Promise<boolean> {
  // Resolves true when nothing was LOST: there was nobody to tell, or every
  // delivery row was stored (sending it is then retried by the cron task).
  // false means an endpoint lookup or a delivery insert failed, i.e. an event that
  // happened was not recorded anywhere. Most callers ignore it; a caller that keeps
  // its own de-dupe flag (the bandwidth thresholds) uses it to un-claim the alert.
  try {
    const supabase = await createAdminClient()
    const { data: endpoints, error } = await supabase
      .from('webhook_endpoints')
      .select(EP_COLS)
      .eq('user_id', userId)
      .eq('enabled', true)
      .overlaps('event_types', [event, WEBHOOK_WILDCARD])

    if (error) {
      console.error('[webhooks] failed to load endpoints for', userId, event, error)
      return false
    }
    // skipIfSubscribedTo: an endpoint that already receives that OTHER event
    // for the same moment is not sent this one too (see runBandwidthThresholdWebhooks).
    const targets = ((endpoints ?? []) as Endpoint[]).filter(
      (ep) => !(opts.skipIfSubscribedTo && subscribesTo(ep.event_types, opts.skipIfSubscribedTo))
    )
    if (!targets.length) return true

    const eventId = crypto.randomUUID()
    const payload = JSON.stringify({ id: eventId, event, api_version: WEBHOOK_API_VERSION, created_at: new Date().toISOString(), data })

    const pending: Promise<unknown>[] = []
    let lost = false
    await Promise.all(
      targets.map(async (ep) => {
        // Inserted as 'retrying' due in 2 minutes: if this Worker dies
        // between insert and first attempt, the retry task still picks it up.
        const { data: row, error: insErr } = await supabase
          .from('webhook_deliveries')
          .insert({
            endpoint_id: ep.id, user_id: userId, event_id: eventId, event_type: event, payload,
            status: 'retrying', attempts: 0,
            next_attempt_at: new Date(Date.now() + (opts.defer ? 0 : 2 * 60_000)).toISOString(),
          })
          .select(DELIVERY_COLS)
          .single()
        if (insErr || !row) {
          console.error('[webhooks] failed to persist delivery', ep.id, insErr)
          lost = true
          return
        }
        if (opts.defer) return
        pending.push(
          attemptDelivery(supabase, ep, row as Delivery, { retry: true }).catch((e) => console.error('[webhooks] attempt crashed', ep.id, e))
        )
      })
    )
    if (pending.length) {
      const all = Promise.all(pending)
      if (!runInBackground(all)) await all
    }
    return !lost
  } catch (e) {
    console.error('[webhooks] dispatch failed', userId, event, e)
    return false
  }
}

// Many events of ONE type for one user in a single pass (revoke-all, bulk jobs): the
// endpoints are loaded once and every delivery row goes in with one insert, then the
// 'webhooks' cron task sends them (defer semantics). Calling dispatchWebhook in a
// loop costs ~3 subrequests per event, which is what an "all 25 keys" revoke —
// the panic button — would burn through. Never throws.
export async function dispatchWebhookBatch(
  userId: string,
  event: WebhookEvent,
  items: Record<string, unknown>[]
): Promise<void> {
  if (!items.length) return
  try {
    const supabase = await createAdminClient()
    const { data: endpoints, error } = await supabase
      .from('webhook_endpoints').select(EP_COLS)
      .eq('user_id', userId).eq('enabled', true).overlaps('event_types', [event, WEBHOOK_WILDCARD])
    if (error) { console.error('[webhooks] batch: failed to load endpoints for', userId, event, error); return }
    if (!endpoints?.length) return

    const now = new Date().toISOString()
    const rows = (endpoints as Endpoint[]).flatMap((ep) =>
      items.map((data) => {
        const eventId = crypto.randomUUID()
        return {
          endpoint_id: ep.id, user_id: userId, event_id: eventId, event_type: event,
          payload: JSON.stringify({ id: eventId, event, api_version: WEBHOOK_API_VERSION, created_at: now, data }),
          status: 'retrying', attempts: 0, next_attempt_at: now,
        }
      })
    )
    const { error: insErr } = await supabase.from('webhook_deliveries').insert(rows)
    if (insErr) console.error('[webhooks] batch: failed to persist deliveries', userId, event, insErr)
  } catch (e) {
    console.error('[webhooks] batch dispatch failed', userId, event, e)
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
  const { data: ep, error: epErr } = await supabase
    .from('webhook_endpoints').select(EP_COLS)
    .eq('id', endpointId).eq('user_id', userId).maybeSingle()
  if (epErr && epErr.code !== '22P02') throw new Error(`webhook lookup failed: ${epErr.message}`)
  if (!ep) return { ok: false, error: 'Webhook not found' }

  const eventId = crypto.randomUUID()
  const payload = JSON.stringify({
    id: eventId, event: 'test', api_version: WEBHOOK_API_VERSION, created_at: new Date().toISOString(),
    data: { message: 'This is a test event from GlobProxy.' },
  })
  const { data: row, error } = await supabase
    .from('webhook_deliveries')
    .insert({ endpoint_id: ep.id, user_id: userId, event_id: eventId, event_type: 'test', payload, status: 'failed', attempts: 0 })
    .select('id, endpoint_id, user_id, event_id, event_type, payload, attempts, status, created_at').single()
  if (error || !row) return { ok: false, error: 'Could not record the test delivery' }

  // Cooldown: insert FIRST, then check we are the earliest test in the window.
  // (Check-then-insert let two simultaneous clicks both pass.) Of any burst the
  // earliest row wins; the rest delete themselves and report the cooldown.
  const since = new Date(Date.now() - TEST_COOLDOWN_MS).toISOString()
  const { data: recent } = await supabase
    .from('webhook_deliveries').select('id')
    .eq('user_id', userId).eq('event_type', 'test').gte('created_at', since)
    .order('created_at', { ascending: true }).order('id', { ascending: true }).limit(1)
  if (recent?.[0] && recent[0].id !== row.id) {
    await supabase.from('webhook_deliveries').delete().eq('id', row.id)
    return { ok: false, error: 'Please wait a few seconds before sending another test.', cooldown: true }
  }

  return attemptDelivery(supabase, ep as Endpoint, row as unknown as Delivery, { retry: false })
}

// Manual re-send of a stored delivery (same event id + body, fresh
// signature timestamp). One attempt, no automatic retries.
export async function redeliverWebhook(userId: string, deliveryId: string, endpointId?: string): Promise<AttemptResult> {
  const supabase = await createAdminClient()
  const { data: d, error: dErr } = await supabase
    .from('webhook_deliveries')
    .select(DELIVERY_COLS)
    .eq('id', deliveryId).eq('user_id', userId).maybeSingle()
  // 22P02 = a malformed id: genuinely "not found". Any other error is ours, not a 404.
  if (dErr && dErr.code !== '22P02') throw new Error(`delivery lookup failed: ${dErr.message}`)
  if (!d || (endpointId && d.endpoint_id !== endpointId)) return { ok: false, error: 'Delivery not found' }
  const { data: ep, error: epErr } = await supabase
    .from('webhook_endpoints').select(EP_COLS)
    .eq('id', d.endpoint_id).eq('user_id', userId).maybeSingle()
  if (epErr) throw new Error(`webhook lookup failed: ${epErr.message}`)
  if (!ep) return { ok: false, error: 'Webhook not found' }
  return attemptDelivery(supabase, ep as Endpoint, d as Delivery, { retry: false, manual: true })
}

// Re-sends an endpoint's FAILED deliveries (oldest first, so receivers see events in
// roughly the order they happened) — the "my receiver was down for an hour, catch me
// up" action, without redelivering them one call at a time. At most `max` (<= 10) per
// call, and it stops after two failures in a row: a receiver that is still down would
// otherwise hold the request for 8 seconds per delivery. Manual redeliveries count
// towards the endpoint's failure streak exactly like single ones do.
export async function redeliverFailedWebhooks(
  userId: string, endpointId: string, max = 5
): Promise<{ ok: true; attempted: number; succeeded: number; more_failed: boolean; stopped_early: boolean } | { ok: false; error: string }> {
  const supabase = await createAdminClient()
  const { data: ep, error: epErr } = await supabase.from('webhook_endpoints').select(EP_COLS).eq('id', endpointId).eq('user_id', userId).maybeSingle()
  if (epErr && epErr.code !== '22P02') throw new Error(`webhook lookup failed: ${epErr.message}`)
  if (!ep) return { ok: false, error: 'Webhook not found' }
  const cap = Math.min(Math.max(Math.trunc(max) || 5, 1), 10)
  const { data: rows, error } = await supabase
    .from('webhook_deliveries')
    .select(DELIVERY_COLS)
    .eq('endpoint_id', endpointId).eq('user_id', userId).eq('status', 'failed').neq('event_type', 'test')
    // Stalest attempt first (never-retried rows lead), then oldest. Ordering by created_at alone
    // let two permanently-rejected deliveries hold the front of the queue forever: every call
    // re-tried just those two, stopped, and never reached the newer failures behind them. A row
    // that fails again gets a fresh last_attempt_at and moves to the back.
    .order('last_attempt_at', { ascending: true, nullsFirst: true })
    .order('created_at', { ascending: true })
    .limit(cap + 1) // one extra: is anything left after this batch?
  if (error) { console.error('[webhooks] redeliver-failed lookup failed', error); return { ok: false, error: 'Could not load deliveries' } }

  const batch = ((rows ?? []) as Delivery[]).slice(0, cap)
  let attempted = 0, succeeded = 0, streak = 0, stopped = false
  for (const d of batch) {
    const r = await attemptDelivery(supabase, ep as Endpoint, d, { retry: false, manual: true })
    attempted++
    if (r.ok) { succeeded++; streak = 0 } else if (++streak >= 2) { stopped = true; break }
  }
  return { ok: true, attempted, succeeded, more_failed: (rows?.length ?? 0) > attempted, stopped_early: stopped }
}

// Cron: retry due deliveries. Each is claimed with a lease first so two
// overlapping runs can't double-send. Fairness: at most PER_ENDPOINT_PER_RUN
// deliveries per endpoint per tick (a customer whose endpoint is down cannot
// starve everyone else), and different endpoints are worked in parallel so one
// slow receiver does not serialise the whole batch behind its 8 s timeout.
export async function runWebhookRetries(limit = RETRIES_PER_RUN) {
  const supabase = await createAdminClient()
  const nowIso = new Date().toISOString()

  // Fairness has to be applied while SELECTING, not after: a single window of
  // the oldest rows can be entirely one dead endpoint's backlog, which used to
  // push every other customer's due deliveries out of the window altogether.
  // Each round excludes the endpoints that already hit their per-tick quota, so
  // the next page reaches further down the queue.
  const PAGE = limit * 4
  const byEndpoint = new Map<string, Delivery[]>()
  const saturated: string[] = []
  let picked = 0
  for (let round = 0; round < 6 && picked < limit; round++) {
    let q = supabase
      .from('webhook_deliveries')
      .select(DELIVERY_COLS)
      .eq('status', 'retrying')
      .lte('next_attempt_at', nowIso)
      .order('next_attempt_at', { ascending: true })
      .limit(PAGE)
    if (saturated.length) q = q.not('endpoint_id', 'in', `(${saturated.join(',')})`)
    const { data: dueRows, error } = await q
    if (error) {
      console.error('[webhooks] failed to load due deliveries', error)
      if (picked === 0) return { due: 0, retried: 0, succeeded: 0 }
      break
    }
    const rows = (dueRows ?? []) as Delivery[]
    for (const d of rows) {
      if (picked >= limit) break
      const list = byEndpoint.get(d.endpoint_id) ?? []
      if (list.length >= PER_ENDPOINT_PER_RUN) continue
      list.push(d)
      byEndpoint.set(d.endpoint_id, list)
      picked++
      if (list.length >= PER_ENDPOINT_PER_RUN && !saturated.includes(d.endpoint_id)) saturated.push(d.endpoint_id)
    }
    if (rows.length < PAGE) break
  }

  let retried = 0
  let succeeded = 0
  const runGroup = async (group: Delivery[]) => {
    let failStreak = 0
    for (const d of group) {
      if (failStreak >= GROUP_STOP_AFTER_FAILURES) break
      if (d.attempts >= MAX_ATTEMPTS) {
        await supabase.from('webhook_deliveries')
          .update({ status: 'failed', next_attempt_at: null, last_error: 'Gave up: the result of the last attempt could not be recorded' })
          .eq('id', d.id).eq('status', 'retrying').eq('attempts', d.attempts)
        continue
      }
      const { data: claimed } = await supabase
        .from('webhook_deliveries')
        .update({ next_attempt_at: new Date(Date.now() + CLAIM_LEASE_MS).toISOString(), attempts: d.attempts + 1 })
        .eq('id', d.id).eq('status', 'retrying').eq('attempts', d.attempts).lte('next_attempt_at', nowIso)
        .select('id')
      if (!claimed?.length) continue

      const { data: ep, error: epErr } = await supabase
        .from('webhook_endpoints').select('id, user_id, url, secret, previous_secret, previous_secret_expires_at, enabled').eq('id', d.endpoint_id).maybeSingle()
      // A failed lookup is not "the endpoint is gone": it used to fail the delivery for good. The claim
      // lease (5 min) simply expires and the next tick tries again.
      if (epErr) {
        console.error('[webhooks] endpoint lookup failed during retry', d.endpoint_id, epErr.message)
        // Nothing was sent, so the attempt taken at claim time is given back (and the row is due again
        // shortly rather than after the 5-minute lease). Otherwise a run of database blips used up the
        // delivery's six attempts without a single request being made.
        await supabase.from('webhook_deliveries')
          .update({ attempts: d.attempts, next_attempt_at: new Date(Date.now() + 60_000).toISOString() })
          .eq('id', d.id).eq('status', 'retrying').eq('attempts', d.attempts + 1)
          .then(() => {}, (e: unknown) => console.error('[webhooks] could not release retry claim', d.id, e))
        continue
      }
      if (!ep || !ep.enabled) {
        await supabase.from('webhook_deliveries')
          .update({ status: 'failed', next_attempt_at: null, last_error: 'Endpoint disabled or deleted before delivery' })
          .eq('id', d.id)
        continue
      }
      const r = await attemptDelivery(supabase, ep as Endpoint, d, { retry: true })
      retried++
      if (r.ok) { succeeded++; failStreak = 0 } else failStreak++
    }
  }
  const groups = [...byEndpoint.values()]
  for (let i = 0; i < groups.length; i += ENDPOINT_PARALLELISM) {
    await Promise.all(groups.slice(i, i + ENDPOINT_PARALLELISM).map((g) => runGroup(g).catch((e) => console.error('[webhooks] retry group failed', e))))
  }
  return { due: picked, retried, succeeded }
}

// Cron (every 5 min): bandwidth-threshold webhooks. Previously fired from
// the once-a-day email run, so a customer crossing 95% at 9am heard about it
// at 8am the next day. Own de-dupe flags (wh_alerted_*), independent of the
// email flags; only accounts that actually have a subscribed endpoint are
// scanned. Highest newly-crossed level fires once; lower levels are marked
// so they don't fire afterwards. Flags clear when usage drops below 80%.
const round1 = (n: number) => Math.round(n * 10) / 10

export async function runBandwidthThresholdWebhooks() {
  const supabase = await createAdminClient()
  // PostgREST silently caps a plain select at 1000 rows, and ids interpolated into
  // an `in (...)` filter travel in the URL (~38 bytes each) — a few hundred
  // subscribed accounts overflow it. Both used to fail without a word: the second
  // query's error was never read, so every account simply stopped being alerted.
  // The endpoint scan is paged and the account lookup is chunked.
  const scan = await fetchAllRows<{ user_id: string }>((from, to) =>
    supabase
      .from('webhook_endpoints').select('user_id')
      .eq('enabled', true)
      .overlaps('event_types', ['bandwidth_threshold_crossed', 'bandwidth_exhausted', WEBHOOK_WILDCARD])
      .order('id', { ascending: true })
      .range(from, to)
  )
  if (scan.error) { console.error('[webhooks] threshold scan failed', scan.error); return { fired: 0 } }
  const userIds = [...new Set(scan.rows.map((e) => e.user_id))]
  if (!userIds.length) return { fired: 0 }

  type ThresholdAccount = {
    user_id: string; total_gb: number | string; available_gb: number | string; used_gb: number | string | null
    allocated_gb: number | string | null; wh_alerted_80_at: string | null; wh_alerted_95_at: string | null; wh_alerted_100_at: string | null
  }
  const accounts: ThresholdAccount[] = []
  const CHUNK = 100
  for (let i = 0; i < userIds.length; i += CHUNK) {
    const { data, error: accErr } = await supabase
      .from('bandwidth_accounts')
      .select('user_id, total_gb, available_gb, used_gb, allocated_gb, wh_alerted_80_at, wh_alerted_95_at, wh_alerted_100_at')
      .in('user_id', userIds.slice(i, i + CHUNK))
      .gt('total_gb', 0)
    if (accErr) { console.error('[webhooks] threshold account lookup failed', accErr.message); continue }
    accounts.push(...((data ?? []) as ThresholdAccount[]))
  }

  let fired = 0
  const nowIso = new Date().toISOString()
  for (const acc of accounts) {
    const total = Number(acc.total_gb)
    const avail = Number(acc.available_gb)
    // The TRIGGER is "how much of the account is committed" (allocated into
    // sessions or reserved): total − available. That is what the e-mail alerts
    // use and what actually blocks new sessions. It was reported to receivers
    // as `used_pct`, which it is not — a reseller with 95% allocated and 3%
    // consumed got used_pct: 95. The payload now carries both, named for what
    // they are.
    const pct = ((total - avail) / total) * 100
    const usedGb = Number(acc.used_gb ?? 0)
    const payloadBase = {
      allocated_pct: round1(pct),
      used_pct: round1((usedGb / total) * 100),
      available_gb: avail, total_gb: total, used_gb: usedGb,
      allocated_gb: Number(acc.allocated_gb ?? total - avail),
    }

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

    // Claim before sending (flag first, then deliver): a duplicate webhook is worse
    // than a late one. If the event could not even be RECORDED (endpoint lookup or
    // delivery insert failed) the claim is taken back below, so the next 5-minute
    // run tries again instead of the alert being lost until usage dips under 80%.
    // Once a delivery row exists, sending it is retried by the 'webhooks' task.
    const flags: Record<string, string> = { wh_alerted_80_at: nowIso }
    if (level >= 95) flags.wh_alerted_95_at = nowIso
    if (level === 100) flags.wh_alerted_100_at = nowIso
    const { error: flagErr } = await supabase.from('bandwidth_accounts').update(flags).eq('user_id', acc.user_id)
    if (flagErr) { console.error('[webhooks] failed to set threshold flag', acc.user_id, flagErr); continue }

    let recorded = true
    if (level === 100) {
      recorded = await dispatchWebhook(acc.user_id, 'bandwidth_exhausted', payloadBase, { defer: true })
      // An endpoint subscribed to the threshold event but not to the exhausted
      // one would otherwise hear nothing at 100% (the de-dupe flags are set
      // either way): give it the final threshold, once.
      recorded = (await dispatchWebhook(acc.user_id, 'bandwidth_threshold_crossed', { threshold_pct: 100, ...payloadBase }, { skipIfSubscribedTo: 'bandwidth_exhausted', defer: true })) && recorded
    } else {
      recorded = await dispatchWebhook(acc.user_id, 'bandwidth_threshold_crossed', { threshold_pct: level, ...payloadBase }, { defer: true })
    }
    if (!recorded) {
      // Put the account back exactly as it was so the next run retries. At 100%
      // two events are sent; if only one of them was stored, the retry repeats that
      // one under a new event id — a duplicate is the lesser evil against a lost alert.
      const { error: undoErr } = await supabase.from('bandwidth_accounts')
        .update({ wh_alerted_80_at: acc.wh_alerted_80_at, wh_alerted_95_at: acc.wh_alerted_95_at, wh_alerted_100_at: acc.wh_alerted_100_at })
        .eq('user_id', acc.user_id)
      if (undoErr) console.error('[webhooks] failed to release threshold claim', acc.user_id, undoErr)
      continue
    }
    fired++
  }
  return { fired }
}

// Integration housekeeping (prune + API-key expiry warnings), run from the
// independent 5-minute 'webhooks' task at most once an hour. It used to live in
// the daily alerts → summary → cleanup chain, which stops at the first failure:
// one failing e-mail run then meant no pruning and no key-expiry warnings.
const HOUSEKEEPING_INTERVAL_MS = 3_600_000
export async function runIntegrationHousekeeping(
  warnExpiring: () => Promise<{ warned: number }>
) {
  const supabase = await createAdminClient()
  const { data: row } = await supabase.from('platform_settings').select('value').eq('key', 'integration_housekeeping_at').maybeSingle()
  const last = row?.value ? Date.parse(row.value) : 0
  if (Number.isFinite(last) && Date.now() - last < HOUSEKEEPING_INTERVAL_MS) return { ran: false as const }

  // Claim the slot first: a duplicate run (overlapping ticks) is harmless — both
  // steps are idempotent — but a stuck failure must not retry every 5 minutes.
  const stamp = new Date().toISOString()
  if (row?.value !== undefined && row?.value !== null) {
    const { data: won, error: claimErr } = await supabase.from('platform_settings')
      .update({ value: stamp }).eq('key', 'integration_housekeeping_at').eq('value', row.value).select('key')
    if (claimErr) { console.error('[webhooks] housekeeping claim failed', claimErr); return { ran: false as const } }
    if (!won?.length) return { ran: false as const }
  } else {
    const { error: claimErr } = await supabase.from('platform_settings')
      .insert({ key: 'integration_housekeeping_at', value: stamp })
    if (claimErr) { if (claimErr.code !== '23505') console.error('[webhooks] housekeeping claim failed', claimErr); return { ran: false as const } }
  }

  const pruned = await pruneIntegrationData().catch((e) => {
    console.error('pruneIntegrationData failed:', e)
    return { deliveries_pruned: false, idempotency_pruned: false, request_log_pruned: false }
  })
  const keyExpiry = await warnExpiring().catch((e) => {
    console.error('warnExpiringApiKeys failed:', e)
    return { warned: 0 }
  })
  return { ran: true as const, ...pruned, api_keys_expiry_warned: keyExpiry.warned }
}

// Cron cleanup: delivery log older than 14 days, idempotency keys older than 24h,
// API request log older than 30 days.
export async function pruneIntegrationData() {
  const supabase = await createAdminClient()
  const dayAgo = new Date(Date.now() - IDEMPOTENCY_WINDOW_MS).toISOString()
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 3_600_000).toISOString()
  const a = await supabase.from('webhook_deliveries').delete().lt('created_at', twoWeeksAgo).neq('status', 'retrying')
  const b = await supabase.from('api_idempotency_keys').delete().lt('created_at', dayAgo)
  const monthAgo = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString()
  const c = await supabase.from('api_request_log').delete().lt('created_at', monthAgo)
  // A rotated-away signing secret has no use once its grace window lapses;
  // keeping it in plaintext forever only widens what a database leak exposes.
  const d = await supabase.from('webhook_endpoints')
    .update({ previous_secret: null, previous_secret_expires_at: null })
    .not('previous_secret', 'is', null).lt('previous_secret_expires_at', new Date().toISOString())
  if (d.error) console.error('[webhooks] expired previous-secret clear failed', d.error)
  if (a.error) console.error('[webhooks] delivery prune failed', a.error)
  if (b.error) console.error('[webhooks] idempotency prune failed', b.error)
  if (c.error) console.error('[webhooks] api request log prune failed', c.error)
  return { deliveries_pruned: !a.error, idempotency_pruned: !b.error, request_log_pruned: !c.error }
}
