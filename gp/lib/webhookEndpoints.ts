import { createAdminClient } from '@/lib/supabase/server'
import { validateWebhookUrlFull } from '@/lib/ssrfGuard'
import { cleanEventTypes, WEBHOOK_EVENTS } from '@/lib/webhookEvents'

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
  'id, url, description, event_types, enabled, created_at, last_success_at, last_failure_at, last_error, consecutive_failures, disabled_at, disabled_reason'

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

const eventsHint = `event_types must be a non-empty array of: ${WEBHOOK_EVENTS.join(', ')}`

export async function listEndpoints(admin: Admin, userId: string): Promise<ServiceResult<any[]>> {
  const { data, error } = await admin
    .from('webhook_endpoints').select(VIEW_COLS).eq('user_id', userId).order('created_at', { ascending: false })
  if (error) { console.error('[webhooks] list failed', error); return fail(500, 'internal_error', 'Could not load webhooks.') }
  return { ok: true, data: data ?? [] }
}

export async function getEndpoint(admin: Admin, userId: string, id: string): Promise<ServiceResult<any>> {
  const { data } = await admin.from('webhook_endpoints').select(VIEW_COLS).eq('id', id).eq('user_id', userId).maybeSingle()
  return data ? { ok: true, data } : fail(404, 'not_found', 'Webhook not found')
}

export async function createEndpoint(admin: Admin, userId: string, body: any): Promise<ServiceResult<any>> {
  const url = typeof body?.url === 'string' ? body.url.trim() : ''
  const urlError = await validateWebhookUrlFull(url)
  if (urlError) return fail(400, 'invalid_request', urlError)

  const events = cleanEventTypes(body?.event_types)
  if (!events) return fail(400, 'invalid_request', eventsHint)

  const desc = parseDescription(body?.description)
  if (!desc.ok) return fail(400, 'invalid_request', desc.error)

  const secret = generateSecret()
  const { data, error } = await admin
    .from('webhook_endpoints')
    .insert({ user_id: userId, url, event_types: events, description: desc.value, secret })
    .select(`${VIEW_COLS}, secret`)
    .single()

  if (error) {
    // The 10-endpoint cap is enforced by a DB trigger (race-free) → 23514.
    if (error.code === '23514') return fail(400, 'invalid_request', 'Maximum of 10 webhook endpoints per account')
    console.error('[webhooks] create failed', error)
    return fail(500, 'internal_error', 'Could not create the webhook.')
  }
  return { ok: true, data }
}

export async function updateEndpoint(admin: Admin, userId: string, id: string, body: any): Promise<ServiceResult<any>> {
  const patch: Record<string, unknown> = {}

  if (body?.url !== undefined) {
    const url = typeof body.url === 'string' ? body.url.trim() : ''
    const urlError = await validateWebhookUrlFull(url)
    if (urlError) return fail(400, 'invalid_request', urlError)
    patch.url = url
  }
  if (body?.event_types !== undefined) {
    const events = cleanEventTypes(body.event_types)
    if (!events) return fail(400, 'invalid_request', eventsHint)
    patch.event_types = events
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
      patch.disabled_at = null
      patch.disabled_reason = null
    }
  }
  if (Object.keys(patch).length === 0) return fail(400, 'invalid_request', 'No fields to update')

  const { data, error } = await admin
    .from('webhook_endpoints').update(patch).eq('id', id).eq('user_id', userId).select(VIEW_COLS).maybeSingle()
  if (error) { console.error('[webhooks] update failed', error); return fail(500, 'internal_error', 'Could not update the webhook.') }
  return data ? { ok: true, data } : fail(404, 'not_found', 'Webhook not found')
}

export async function deleteEndpoint(admin: Admin, userId: string, id: string): Promise<ServiceResult<{ deleted: true }>> {
  const { error, count } = await admin.from('webhook_endpoints').delete({ count: 'exact' }).eq('id', id).eq('user_id', userId)
  if (error) { console.error('[webhooks] delete failed', error); return fail(500, 'internal_error', 'Could not delete the webhook.') }
  return count ? { ok: true, data: { deleted: true } } : fail(404, 'not_found', 'Webhook not found')
}

// Replaces the signing secret immediately and returns the new one once.
// (A leaked secret previously meant deleting and recreating the endpoint,
// which also changed its id.)
export async function rotateSecret(admin: Admin, userId: string, id: string): Promise<ServiceResult<{ id: string; secret: string }>> {
  const secret = generateSecret()
  const { data, error } = await admin
    .from('webhook_endpoints').update({ secret }).eq('id', id).eq('user_id', userId).select('id').maybeSingle()
  if (error) { console.error('[webhooks] rotate failed', error); return fail(500, 'internal_error', 'Could not rotate the secret.') }
  return data ? { ok: true, data: { id: data.id, secret } } : fail(404, 'not_found', 'Webhook not found')
}

export async function listDeliveries(
  admin: Admin, userId: string, endpointId: string, opts: { limit?: number; status?: string | null } = {}
): Promise<ServiceResult<any[]>> {
  const owned = await admin.from('webhook_endpoints').select('id').eq('id', endpointId).eq('user_id', userId).maybeSingle()
  if (!owned.data) return fail(404, 'not_found', 'Webhook not found')

  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50) || 50, 1), 100)
  let q = admin
    .from('webhook_deliveries')
    .select('id, event_id, event_type, status, attempts, next_attempt_at, last_attempt_at, response_status, last_error, duration_ms, created_at')
    .eq('endpoint_id', endpointId).eq('user_id', userId)
    .order('created_at', { ascending: false }).limit(limit)
  if (opts.status && ['succeeded', 'retrying', 'failed'].includes(opts.status)) q = q.eq('status', opts.status)

  const { data, error } = await q
  if (error) { console.error('[webhooks] deliveries failed', error); return fail(500, 'internal_error', 'Could not load deliveries.') }
  return { ok: true, data: data ?? [] }
}
