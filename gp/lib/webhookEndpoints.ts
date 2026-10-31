import { createAdminClient } from '@/lib/supabase/server'
import { validateWebhookUrlFull } from '@/lib/ssrfGuard'
import { parseEventTypes, isWebhookEvent } from '@/lib/webhookEvents'
import { applyCursor, isUuidString } from '@/lib/cursor'

// Webhook-endpoint management, shared by /api/dashboard/webhooks/* (session
// auth) and /api/v1/webhooks/* (API-key auth) so both surfaces enforce
// identical rules. All writes use the admin client after an explicit
// user_id scope — RLS can't run the SSRF guard (migration 0018).
type Admin = Awaited<ReturnType<typeof createAdminClient>>

export type ServiceError = { ok: false; status: number; code: 'invalid_request' | 'not_found' | 'conflict' | 'internal_error'; message: string }
export type ServiceOk<T> = { ok: true; data: T }
export type ServiceResult<T> = ServiceOk<T> | ServiceError

const fail = (status: number, code: ServiceError['code'], message: string): ServiceError => ({ ok: false, status, code, message })

// `secret` is deliberately absent: it is returned once (create / rotate) only.
const VIEW_COLS =
  'id, url, description, event_types, enabled, created_at, last_success_at, last_failure_at, last_error, consecutive_failures, disabled_at, disabled_reason, previous_secret_expires_at'

// Clears the failure streak bookkeeping (see record_webhook_attempt, migration 0089).
const FRESH_STREAK = { consecutive_failures: 0, failing_since: null, last_error: null } as const

function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return `whsec_${Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

function parseDescription(v: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (v === undefined || v === null || v === '') return { ok: true, value: null }
  if (typeof v !== 'string') return { ok: false, error: 'description must be a string.' }
  // eslint-disable-next-line no-control-regex
  const d = v.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (d.length > 200) return { ok: false, error: 'description must be 200 characters or fewer.' }
  return { ok: true, value: d || null }
}

export async function listEndpoints(admin: Admin, userId: string): Promise<ServiceResult<any[]>> {
  const { data, error } = await admin
    .from('webhook_endpoints').select(VIEW_COLS).eq('user_id', userId).order('created_at', { ascending: false })
  if (error) { console.error('[webhooks] list failed', error); return fail(500, 'internal_error', 'Could not load webhooks.') }
  return { ok: true, data: data ?? [] }
}

export async function getEndpoint(admin: Admin, userId: string, id: string): Promise<ServiceResult<any>> {
  if (!isUuidString(id)) return fail(404, 'not_found', 'Webhook not found')
  const { data, error } = await admin.from('webhook_endpoints').select(VIEW_COLS).eq('id', id).eq('user_id', userId).maybeSingle()
  if (error) { console.error('[webhooks] get failed', error); return fail(500, 'internal_error', 'Could not load the webhook.') }
  return data ? { ok: true, data } : fail(404, 'not_found', 'Webhook not found')
}

export async function createEndpoint(admin: Admin, userId: string, body: any): Promise<ServiceResult<any>> {
  const url = typeof body?.url === 'string' ? body.url.trim() : ''
  const urlError = await validateWebhookUrlFull(url)
  if (urlError) return fail(400, 'invalid_request', urlError)

  const events = parseEventTypes(body?.event_types)
  if (!events.ok) return fail(400, 'invalid_request', events.error)

  const desc = parseDescription(body?.description)
  if (!desc.ok) return fail(400, 'invalid_request', desc.error)

  const secret = generateSecret()
  const { data, error } = await admin
    .from('webhook_endpoints')
    .insert({ user_id: userId, url, event_types: events.value, description: desc.value, secret })
    .select(`${VIEW_COLS}, secret`)
    .single()

  if (error) {
    // The 10-endpoint cap is enforced by a DB trigger (race-free) → 23514.
    // Only the cap trigger's message — any OTHER check violation used to be
    // reported as "maximum of 10 endpoints" too.
    if (error.code === '23514' && /maximum/i.test(error.message ?? '')) return fail(400, 'invalid_request', 'Maximum of 10 webhook endpoints per account')
    console.error('[webhooks] create failed', error)
    return fail(500, 'internal_error', 'Could not create the webhook.')
  }
  return { ok: true, data }
}

export async function updateEndpoint(admin: Admin, userId: string, id: string, body: any): Promise<ServiceResult<any>> {
  // A malformed id used to reach Postgres (22P02) and come back as a 500.
  if (!isUuidString(id)) return fail(404, 'not_found', 'Webhook not found')
  const patch: Record<string, unknown> = {}

  // The dashboard edit form (and many API clients) send the whole object, so `url` arrives on every
  // save even when only the description or the events changed. Only a DIFFERENT address is a new
  // address: re-sending the stored one must not wipe the failure streak of an endpoint that is still
  // failing (it would never reach the auto-disable threshold while its owner kept editing it), nor
  // be refused because a DNS lookup of an address nobody changed hiccupped.
  let urlUnchanged = false
  if (body?.url !== undefined) {
    const url = typeof body.url === 'string' ? body.url.trim() : ''
    const { data: cur, error: curErr } = await admin
      .from('webhook_endpoints').select('url').eq('id', id).eq('user_id', userId).maybeSingle()
    if (curErr) { console.error('[webhooks] update lookup failed', curErr); return fail(500, 'internal_error', 'Could not update the webhook.') }
    if (!cur) return fail(404, 'not_found', 'Webhook not found')
    if (url !== '' && cur.url === url) {
      urlUnchanged = true
    } else {
      const urlError = await validateWebhookUrlFull(url)
      if (urlError) return fail(400, 'invalid_request', urlError)
      patch.url = url
      // A new address is a fresh start, like re-enabling: the failure streak belongs to the OLD address.
      // Left in place, one failed delivery to the corrected URL could complete a 50-failure / 24-hour
      // streak and switch the endpoint off. `enabled` itself is never touched here.
      Object.assign(patch, FRESH_STREAK)
    }
  }
  if (body?.event_types !== undefined) {
    const events = parseEventTypes(body.event_types)
    if (!events.ok) return fail(400, 'invalid_request', events.error)
    patch.event_types = events.value
  }
  if (body?.description !== undefined) {
    const desc = parseDescription(body.description)
    if (!desc.ok) return fail(400, 'invalid_request', desc.error)
    patch.description = desc.value
  }
  if (body?.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return fail(400, 'invalid_request', 'enabled must be a boolean.')
    patch.enabled = body.enabled
    if (body.enabled) {
      // Re-enabling is a fresh start: clear the failure streak and the
      // auto-disable markers so it isn't instantly disabled again.
      patch.consecutive_failures = 0
      patch.failing_since = null
      patch.disabled_at = null
      patch.disabled_reason = null
    }
  }
  if (Object.keys(patch).length === 0) {
    // Only the stored address was re-sent: nothing to change, and not an error for the caller.
    if (urlUnchanged) return getEndpoint(admin, userId, id)
    return fail(400, 'invalid_request', 'No fields to update')
  }

  const { data, error } = await admin
    .from('webhook_endpoints').update(patch).eq('id', id).eq('user_id', userId).select(VIEW_COLS).maybeSingle()
  if (error) { console.error('[webhooks] update failed', error); return fail(500, 'internal_error', 'Could not update the webhook.') }
  return data ? { ok: true, data } : fail(404, 'not_found', 'Webhook not found')
}

export async function deleteEndpoint(admin: Admin, userId: string, id: string): Promise<ServiceResult<{ deleted: true }>> {
  if (!isUuidString(id)) return fail(404, 'not_found', 'Webhook not found')
  const { error, count } = await admin.from('webhook_endpoints').delete({ count: 'exact' }).eq('id', id).eq('user_id', userId)
  if (error) { console.error('[webhooks] delete failed', error); return fail(500, 'internal_error', 'Could not delete the webhook.') }
  return count ? { ok: true, data: { deleted: true } } : fail(404, 'not_found', 'Webhook not found')
}

export const MAX_ROTATION_GRACE_MINUTES = 72 * 60

// Replaces the signing secret and returns the new one once. (A leaked secret
// previously meant deleting and recreating the endpoint, which also changed its
// id.) With `graceMinutes` > 0 the OLD secret keeps signing a second header
// (X-GlobProxy-Signature-V2-Previous) until the window lapses, so a receiver
// can be switched over without dropping deliveries. 0 (default) = the old
// secret stops working immediately — right for a LEAKED secret.
export async function rotateSecret(
  admin: Admin, userId: string, id: string, graceMinutes = 0
): Promise<ServiceResult<{ id: string; secret: string; previous_secret_expires_at: string | null }>> {
  if (!Number.isFinite(graceMinutes) || graceMinutes < 0 || graceMinutes > MAX_ROTATION_GRACE_MINUTES) {
    return fail(400, 'invalid_request', `grace_minutes must be between 0 and ${MAX_ROTATION_GRACE_MINUTES}.`)
  }
  if (!isUuidString(id)) return fail(404, 'not_found', 'Webhook not found')
  const { data: current, error: curErr } = await admin
    .from('webhook_endpoints').select('secret').eq('id', id).eq('user_id', userId).maybeSingle()
  if (curErr) { console.error('[webhooks] rotate lookup failed', curErr); return fail(500, 'internal_error', 'Could not rotate the secret.') }
  if (!current) return fail(404, 'not_found', 'Webhook not found')

  const secret = generateSecret()
  const expires = graceMinutes > 0 ? new Date(Date.now() + graceMinutes * 60_000).toISOString() : null
  const { data, error } = await admin
    .from('webhook_endpoints')
    // A rotation is the usual fix for signature failures, so it also starts the streak over.
    .update({ secret, previous_secret: graceMinutes > 0 ? current.secret : null, previous_secret_expires_at: expires, ...FRESH_STREAK })
    // Compare-and-set on the secret we read: two concurrent rotations used to both succeed, and the
    // loser was handed a secret that was already replaced. The loser now gets a 409 and retries.
    .eq('id', id).eq('user_id', userId).eq('secret', current.secret).select('id').maybeSingle()
  if (error) { console.error('[webhooks] rotate failed', error); return fail(500, 'internal_error', 'Could not rotate the secret.') }
  if (!data) {
    const { data: still } = await admin.from('webhook_endpoints').select('id').eq('id', id).eq('user_id', userId).maybeSingle()
    return still ? fail(409, 'conflict', 'The secret was rotated by another request at the same time. Retry to rotate again.') : fail(404, 'not_found', 'Webhook not found')
  }
  return { ok: true, data: { id: data.id, secret, previous_secret_expires_at: expires } }
}

const DELIVERY_LIST_COLS =
  'id, event_id, event_type, status, attempts, next_attempt_at, last_attempt_at, response_status, last_error, duration_ms, created_at'

// Newest first. `before` (an ISO timestamp — the previous page's last
// created_at) with `beforeId` (that row's id) pages further back; without it only the latest `limit` came
// back, so older failures could not be reached at all.
export async function listDeliveries(
  admin: Admin, userId: string, endpointId: string,
  opts: { limit?: number; status?: string | null; eventType?: string | null; before?: string | null; beforeId?: string | null } = {}
): Promise<ServiceResult<{ rows: any[]; has_more: boolean }>> {
  if (!isUuidString(endpointId)) return fail(404, 'not_found', 'Webhook not found')
  const owned = await admin.from('webhook_endpoints').select('id').eq('id', endpointId).eq('user_id', userId).maybeSingle()
  if (owned.error) { console.error('[webhooks] ownership check failed', owned.error); return fail(500, 'internal_error', 'Could not load deliveries.') }
  if (!owned.data) return fail(404, 'not_found', 'Webhook not found')

  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50) || 50, 1), 100)
  // An unknown filter value used to be ignored, silently returning EVERY delivery.
  if (opts.status && !['succeeded', 'retrying', 'failed'].includes(opts.status)) {
    return fail(400, 'invalid_request', 'status must be one of: succeeded, retrying, failed.')
  }
  if (opts.eventType && opts.eventType !== 'test' && !isWebhookEvent(opts.eventType)) {
    return fail(400, 'invalid_request', 'event_type must be one of the event names from GET /api/v1/webhooks/events (or "test").')
  }
  let q = admin
    .from('webhook_deliveries')
    .select(DELIVERY_LIST_COLS)
    .eq('endpoint_id', endpointId).eq('user_id', userId)
    .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1) // one extra row: is there another page?
  if (opts.status) q = q.eq('status', opts.status)
  if (opts.eventType) q = q.eq('event_type', opts.eventType)
  const cur = applyCursor(q, opts.before, opts.beforeId, 'uuid')
  if (!cur.ok) return fail(400, 'invalid_request', cur.message)
  q = cur.query

  const { data, error } = await q
  if (error) { console.error('[webhooks] deliveries failed', error); return fail(500, 'internal_error', 'Could not load deliveries.') }
  const fetched = data ?? []
  return { ok: true, data: { rows: fetched.slice(0, limit), has_more: fetched.length > limit } }
}

// One delivery in full: the exact signed JSON body that was (or will be) sent,
// and the first bytes of the receiver's last response.
export async function getDelivery(
  admin: Admin, userId: string, endpointId: string, deliveryId: string
): Promise<ServiceResult<any>> {
  if (!isUuidString(endpointId) || !isUuidString(deliveryId)) return fail(404, 'not_found', 'Delivery not found')
  const { data, error } = await admin
    .from('webhook_deliveries')
    .select(`${DELIVERY_LIST_COLS}, payload, response_body`)
    .eq('id', deliveryId).eq('endpoint_id', endpointId).eq('user_id', userId).maybeSingle()
  if (error && error.code !== '22P02') { console.error('[webhooks] delivery detail failed', error); return fail(500, 'internal_error', 'Could not load the delivery.') }
  if (!data) return fail(404, 'not_found', 'Delivery not found')
  let payload: unknown = data.payload
  try { payload = JSON.parse(data.payload as string) } catch { /* leave as text */ }
  return { ok: true, data: { ...data, payload } }
}
