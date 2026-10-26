import { createAdminClient } from '@/lib/supabase/server'
import { leaksSupplier } from '@/lib/supplierGuard'
import {
  createSubUser, createOrAdoptSubUser, memoizedSubUserLookup, newUpstreamIdentity, deleteSubUser, getSubUserUsage, updateSubUserTrafficLimit, updateSubUserPassword,
  classifyUpstreamError, UpstreamApiError, upstreamConfigured, subUserExists, type UpstreamReason, type UpstreamIdentity, PROXY_HOST,
} from '@/lib/upstream'
import { sendEmail, escapeHtml } from '@/lib/email'
import { appUrl } from '@/lib/appUrl'
import { buildProxyUsername, getProxyPort, deriveSessionId } from '@/lib/proxyEndpoint'
import { dispatchWebhook } from '@/lib/webhooks'
import { fetchAllRows } from '@/lib/dbPaging'
import { isUuidString } from '@/lib/cursor'
import { recordUsageDeltas } from '@/lib/usageLedger'
import { replayWhitelist } from '@/lib/whitelistMirror'
import { IDEMPOTENCY_WINDOW_MS } from '@/lib/idempotency'
import { parseLabel, parseTargeting, parseSessionOptions, parseFiniteNumber, MAX_ENDPOINT_COUNT, type CreateCredentialInput } from '@/lib/apiValidation'

// The single implementation of credential create / delete / top-up /
// pending-provisioning, shared by the dashboard routes (session auth) and
// the public v1 API (key auth). They used to be two copies that had
// already drifted (one fired webhooks, one didn't; one checked the provider
// was configured, one didn't), and — worse — the dashboard copy called the
// bandwidth reserve/release RPCs with the *browser-session* client, which is
// why those RPCs had to be callable by any logged-in user (migration 0040
// revokes that). Everything here uses the admin client; callers have
// already authenticated and passed the user's id.
type Admin = Awaited<ReturnType<typeof createAdminClient>>

// Neutral re-exports for modules that must not mention the supplier (scripts/check-supplier-leak.mjs).
export { subUserExists, getSubUserUsage }

export type CredErrorCode =
  | 'invalid_request' | 'not_found' | 'forbidden' | 'conflict'
  | 'insufficient_bandwidth' | 'upstream_unavailable' | 'internal_error'
export type CredFail = { ok: false; status: number; code: CredErrorCode; message: string }
export type CredResult<T> = { ok: true; data: T } | CredFail
const fail = (status: number, code: CredErrorCode, message: string): CredFail => ({ ok: false, status, code, message })

export function providerConfigured(): boolean {
  return upstreamConfigured()
}

// Mirrors enforce_credential_limit() (migration 0046).
export const MAX_CREDENTIALS_PER_ACCOUNT = 100

export const CRED_COLS =
  'id, label, status, gb_allocated, gb_used, country, state, city, asn, session_type, protocol, sticky_duration, endpoint_count, host, port, upstream_username, upstream_password, activated_at, created_at, created_by, auto_topup_enabled, auto_topup_threshold_gb, auto_topup_amount_gb, pending_reason, suspended_reason'

// Public API shape for a credential. `password` is returned because the
// credential is unusable without it (the dashboard reads the same column
// directly) — treat API keys with the same care as the passwords they expose.
/**
 * Dashboard counterpart of toApiCredential's supplier guard. The proxies page
 * reads the raw row with the service role (the username/password columns are
 * not customer-selectable), so it must apply the same rule before the row is
 * serialised into the browser: nothing that names the upstream supplier is ever
 * shown, exported or embedded in a code snippet.
 *  - host / username fall back to our own neutral values;
 *  - free-text reason columns are dropped (the UI only compares them to fixed
 *    enum strings, so a stray value is useless to it and unsafe to ship).
 */
// A just-created sub-user can be absent from the supplier's listing for a few minutes. Neither the
// admin alert (usageSync) nor the customer's "not responding" notice (dashboard) acts before this.
export const UPSTREAM_MISSING_GRACE_MS = 10 * 60_000

export function toDashboardCredential(row: Record<string, any>): Record<string, any> {
  const { upstream_username, upstream_password, ...rest } = row
  const out: Record<string, any> = {
    ...rest,
    username: upstream_username ?? null,
    password: upstream_password ?? null,
  }
  if (leaksSupplier(out.host)) out.host = PROXY_HOST
  // null, not a made-up name: a fabricated login would not exist upstream. The dashboard shows
  // a session with no username/password as "details not available yet" instead.
  if (leaksSupplier(out.username)) { out.username = null; out.password = null }
  if (leaksSupplier(out.password)) out.password = null
  if (leaksSupplier(out.label)) out.label = 'Session'
  for (const k of ['pending_reason', 'suspended_reason'] as const) {
    if (leaksSupplier(out[k])) out[k] = null
  }
  return out
}

export function toApiCredential(c: any) {
  // Second line of defence behind the check at provisioning (lib/upstream.ts): a
  // stored username that names the supplier is never handed to a customer. They get
  // a credential that reads as "not ready" and the operator gets a log line.
  if (leaksSupplier(c?.upstream_username)) {
    console.error('[supplier-guard] withheld a proxy username that names the supplier, credential', c?.id)
    c = { ...c, upstream_username: null, upstream_password: null }
  }
  const used = Number(c.gb_used ?? 0)
  const allocated = Number(c.gb_allocated ?? 0)
  return {
    id: c.id,
    label: c.label,
    status: c.status,
    gb_allocated: allocated,
    gb_used: used,
    gb_remaining: Math.max(0, allocated - used),
    country: c.country, state: c.state, city: c.city, asn: c.asn,
    session_type: c.session_type, protocol: c.protocol ?? 'http',
    sticky_duration: c.sticky_duration, endpoint_count: c.endpoint_count,
    // Same rule for the host: a stored host that names the supplier is never shown.
    host: leaksSupplier(c.host) ? PROXY_HOST : c.host, port: c.port,
    username: c.upstream_username, // raw proxy username
    // NOTE: a legacy `upstream_username` alias used to be returned here. It named
    // our upstream supplier to every API customer, so it was removed — use
    // `username` (or, better, `connection_username`).
    password: c.upstream_password ?? null,
    // The username to put in the proxy connection string — includes the
    // country/state/city/ASN/session targeting suffixes.
    // Sticky sessions need a STABLE session id: with none, buildProxyUsername mints
    // a random one per call, so every fetch of the same sub-user returned a
    // different username (= a different exit IP). Derived from the credential id,
    // exactly like the dashboard's quick endpoint; named sessions
    // (/sessions) are the explicit way to get another one.
    connection_username: c.upstream_username
      ? buildProxyUsername(c.upstream_username, c, c.session_type === 'sticky' && c.id ? deriveSessionId(String(c.id), 0) : undefined)
      : null,
    auto_topup: {
      enabled: !!c.auto_topup_enabled,
      threshold_gb: c.auto_topup_threshold_gb ?? null,
      amount_gb: c.auto_topup_amount_gb ?? null,
    },
    // Supplier-neutral: why a 'pending' session hasn't come online yet
    // ('capacity' | 'unavailable' | 'error'), else null.
    pending_reason: c.status === 'pending' ? (c.pending_reason ?? null) : null,
    // true only for a sub-user YOU paused (POST /sub-users/:id/pause); a session
    // suspended by GlobProxy can't be resumed from the API.
    can_resume: c.status === 'suspended' && c.suspended_reason === 'customer',
    activated_at: c.activated_at,
    created_at: c.created_at,
  }
}

// null means "no such sub-user for this account" — a malformed id included. A DATABASE error is
// NOT that: it used to be swallowed here, so a blip answered 404 "Sub-user not found" (and a
// DELETE or bulk delete then looked like "already gone" to an automation). It now throws; the
// v1 wrapper turns that into a 500 the client can retry.
export async function getOwnedCredential(admin: Admin, userId: string, id: string, cols = CRED_COLS) {
  if (!isUuidString(id)) return null
  const { data, error } = await admin.from('proxy_credentials').select(cols).eq('id', id).eq('user_id', userId).maybeSingle()
  if (error) throw new Error(`getOwnedCredential failed: ${error.code ?? ''} ${error.message}`)
  return (data as any) ?? null
}

// What gets PERSISTED in proxy_credentials.last_provision_error. Customers hold
// SELECT on that table, so the raw upstream error (it names the supplier and
// can carry its account state, e.g. "...createSubUser failed: 402 {insufficient
// balance}") must never be written there. Store a neutral code; the full
// detail is already logged server-side (console.error) at every call site.
const errMsg = (e: unknown) => {
  const status = (e as any)?.status
  return typeof status === 'number' ? `upstream_error_${status}` : 'provision_failed'
}
const isGone = (e: unknown) => e instanceof UpstreamApiError && e.status === 404

// ── Create ────────────────────────────────────────────────────────────
export async function createCredential(
  admin: Admin,
  userId: string,
  input: CreateCredentialInput,
  opts: { source: 'api' | 'dashboard'; autoTopup?: { threshold_gb: number; amount_gb: number } | null; idempotencyKey?: string | null }
): Promise<CredResult<{ cred: any; warning?: string; replayed?: boolean }>> {
  const gb = input.gb_allocated
  const idemKey = opts.idempotencyKey ?? null

  // An earlier attempt with this key already created the credential (it died
  // before recording its response, or this is a stale-claim takeover). Return
  // it as-is — no second reservation, no second upstream sub-user.
  if (idemKey) {
    const { data: existing } = await admin
      .from('proxy_credentials').select(CRED_COLS).eq('user_id', userId).eq('idempotency_key', idemKey).maybeSingle()
    if (existing) {
      const age = Date.now() - new Date(existing.created_at as string).getTime()
      if (!(age > IDEMPOTENCY_WINDOW_MS)) return { ok: true, data: { cred: existing, replayed: true } }
      // The key's 24-hour memory has lapsed (the claim row is pruned) but the stamp on the old
      // session is permanent. Replaying it would hand a NEW request, possibly with different
      // parameters, an old session. Release the stamp so this is treated as the new request it is.
      await admin.from('proxy_credentials').update({ idempotency_key: null }).eq('id', existing.id).eq('idempotency_key', idemKey)
    }
  }

  // Soft pre-check of the per-account cap (the database trigger from
  // migration 0046 is the authoritative, race-free enforcement). Without
  // this a user at the cap would reserve bandwidth and create a real Upstream
  // sub-user only to have the insert rejected and everything unwound.
  const { count: liveCount } = await admin
    .from('proxy_credentials').select('id', { count: 'exact', head: true })
    .eq('user_id', userId).in('status', ['active', 'pending'])
  if ((liveCount ?? 0) >= MAX_CREDENTIALS_PER_ACCOUNT) {
    return fail(409, 'conflict', `Session limit reached (${MAX_CREDENTIALS_PER_ACCOUNT}). Delete an unused session first.`)
  }

  // 1. Reserve atomically (migration 0007) — no window between "checked" and
  // "reserved" for a concurrent request to slip through.
  const { error: reserveErr } = await admin.rpc('reserve_credential_bandwidth', { p_user_id: userId, p_gb: gb })
  if (reserveErr) {
    if (reserveErr.message?.includes('Insufficient')) {
      return fail(402, 'insufficient_bandwidth', `Insufficient bandwidth. Requested ${gb}GB is more than you have available. Purchase more to continue.`)
    }
    console.error('[credentials] reserve failed', reserveErr)
    return fail(500, 'internal_error', 'Could not reserve bandwidth. Please try again.')
  }

  // The upstream identity is fixed up front so an ambiguous failure (timeout /
  // 5xx after the supplier DID create the sub-user) can be adopted on retry
  // instead of being orphaned (see createOrAdoptSubUser).
  const credId = crypto.randomUUID()
  const identity = newUpstreamIdentity(credId)
  let upstreamAttempted = false
  let createdCred: any = null // set once the row is inserted: from then on the reservation belongs to it

  const release = async (why: string) => {
    const { error } = await admin.rpc('release_credential_bandwidth', { p_user_id: userId, p_gb: gb })
    if (error) console.error(`[credentials] FAILED to release ${gb}GB reservation after ${why} — needs manual reconciliation`, userId, error)
  }

  try {
    // 2. Upstream. A failure leaves the credential 'pending' (the reservation
    // stands); the 'provision' cron task retries it with backoff.
    let gcred: Awaited<ReturnType<typeof createSubUser>> | null = null
    let status: 'active' | 'pending' = 'pending'
    // Only supplier-NEUTRAL codes are ever persisted on the row (it is
    // readable by the customer's browser session and shown in the UI); the
    // raw upstream error goes to the server log only.
    let provisionError: string | null = null
    let pendingReason: UpstreamReason | null = null
    if (providerConfigured()) {
      try {
        upstreamAttempted = true
        gcred = await createSubUser({
          label: input.label ?? `gp_${Date.now()}`,
          gb_limit: gb,
          country: input.country ?? undefined, state: input.state ?? undefined, city: input.city ?? undefined,
          asn: input.asn ?? undefined,
          protocol: input.protocol, session_type: input.session_type,
          sticky_duration: input.sticky_duration ?? undefined,
        }, identity)
        status = 'active'
      } catch (e) {
        provisionError = errMsg(e) // neutral code (see errMsg) — raw detail is logged below
        pendingReason = classifyUpstreamError(e)
        console.error('[credentials] Upstream createSubUser failed — leaving credential pending:', pendingReason, e)
      }
    } else {
      provisionError = 'provider_not_configured'
      pendingReason = 'unavailable'
    }

    // 3. Persist
    const { data: cred, error: insertErr } = await admin
      .from('proxy_credentials')
      .insert({
        id: credId,
        user_id: userId,
        label: input.label,
        upstream_sub_user_id: gcred?.upstream_sub_user_id ?? null,
        upstream_username: gcred?.username ?? null,
        upstream_password: gcred?.password ?? null,
        host: gcred?.host ?? 'proxy.globproxy.com',
        port: gcred?.port ?? getProxyPort(input.protocol, input.session_type),
        protocol: input.protocol,
        session_type: input.session_type,
        sticky_duration: input.sticky_duration,
        endpoint_count: input.endpoint_count,
        gb_allocated: gb,
        gb_used: 0,
        country: input.country, state: input.state, city: input.city, asn: input.asn,
        status,
        activated_at: status === 'active' ? new Date().toISOString() : null,
        // Left NULL so the first retry (cron tick or the customer's "Retry now")
        // is eligible immediately. Stamping it here made claim_pending_credentials'
        // 2-minute in-flight guard refuse a Retry for two minutes with a false
        // "an attempt is already in progress" — nothing is in flight: this create
        // attempt has already finished.
        provisioning_claimed_at: null,
        // Remembered only when the supplier was really called, so the retry knows
        // to look for a sub-user an ambiguous failure may already have created.
        provision_username: status === 'pending' && upstreamAttempted ? identity.username : null,
        provision_password: status === 'pending' && upstreamAttempted ? identity.password : null,
        provision_attempts: status === 'pending' ? 1 : 0,
        last_provision_error: status === 'pending' ? provisionError : null,
        idempotency_key: idemKey,
        pending_reason: status === 'pending' ? pendingReason : null,
      })
      .select(CRED_COLS)
      .single()

    if (insertErr || !cred) {
      console.error('[credentials] insert failed', insertErr)
      if (gcred) {
        await deleteSubUser(gcred.upstream_sub_user_id).catch((e) =>
          console.error('[credentials] FAILED to clean up orphaned Upstream sub-user', gcred?.upstream_sub_user_id, e))
      }
      await release('insert failure')
      // Lost the race to a concurrent attempt with the SAME Idempotency-Key:
      // its credential is the one true result. We've already unwound our own
      // reservation and upstream sub-user above, so just return the winner.
      if (idemKey && insertErr?.code === '23505') {
        const { data: winner } = await admin
          .from('proxy_credentials').select(CRED_COLS).eq('user_id', userId).eq('idempotency_key', idemKey).maybeSingle()
        if (winner) return { ok: true, data: { cred: winner, replayed: true } }
      }
      // Lost a race for the last slot against a concurrent create.
      if (insertErr?.code === '23514' && String(insertErr.message).includes('Session limit')) {
        return fail(409, 'conflict', `Session limit reached (${MAX_CREDENTIALS_PER_ACCOUNT}). Delete an unused session first.`)
      }
      return fail(500, 'internal_error', 'Could not create the sub-user. Please try again.')
    }

    createdCred = cred

    // 4. Optional auto top-up (set_auto_topup owns config validity).
    let warning: string | undefined
    if (opts.autoTopup) {
      const { error: autoErr } = await admin.rpc('set_auto_topup', {
        p_credential_id: cred.id, p_user_id: userId, p_enabled: true,
        p_threshold_gb: opts.autoTopup.threshold_gb, p_amount_gb: opts.autoTopup.amount_gb,
      })
      if (autoErr) {
        console.error('[credentials] failed to enable auto top-up on new credential', cred.id, autoErr)
        warning = 'Session created, but auto-allocate couldn\u2019t be turned on — enable it from the Bandwidth tab.'
      }
    }

    // 5. Notify. Awaited (Workers) and never throws.
    await dispatchWebhook(userId, 'session_created', {
      credential_id: cred.id, label: cred.label, protocol: cred.protocol, session_type: cred.session_type,
      gb_allocated: Number(cred.gb_allocated), country: cred.country ?? null, state: cred.state ?? null,
      city: cred.city ?? null, asn: cred.asn ?? null, status: cred.status, source: opts.source,
    })

    return { ok: true, data: { cred, warning } }
  } catch (e) {
    // Anything unexpected after the reservation: give it back — unless the row already exists,
    // in which case the reservation backs a real session and releasing it would count the same
    // bandwidth twice. That session is returned as created.
    console.error('[credentials] unexpected error during create', e)
    if (createdCred) return { ok: true, data: { cred: createdCred, warning: 'Session created, but a follow-up step failed. Check its settings.' } }
    await release('unexpected error')
    return fail(500, 'internal_error', 'Internal error. Please try again.')
  }
}

// ── Delete ────────────────────────────────────────────────────────────
// Ordering guarantees (shared with the dashboard route and DELETE
// /api/v1/sub-users/:id):
//   1. the upstream (provider) delete must succeed — or the sub-user already
//      be gone (404) — BEFORE any local record changes. A transient
//      upstream failure used to be swallowed: the row was deleted and the
//      unused GB released while the sub-user kept working with its cap.
//   2. the local half is ONE transaction, delete_own_credential()
//      (migration 0040): delete the row, release the unused reservation and
//      archive the consumed GB together, so a failure between those steps
//      can no longer leak or double-spend a reservation. The larger of the
//      live and last-synced usage counts as consumed, so a failed or stale
//      live read can never hand back too much.
// A failure at (1) changes nothing and is safe to retry; a retry after a
// failure at (2) completes cleanly because the upstream 404 counts as gone.
export async function deleteCredential(
  admin: Admin, userId: string, id: string, source: 'api' | 'dashboard'
): Promise<CredResult<{ gb_released: number; gb_used: number }>> {
  const cred = await getOwnedCredential(admin, userId, id, '*')
  if (!cred) return fail(404, 'not_found', 'Sub-user not found')

  // Resellers cannot reverse allocations — clients paid them for this
  // bandwidth. (Any created_by, not just "someone else": delete_own_credential
  // only ever deletes rows with created_by IS NULL.)
  if (cred.created_by) {
    return fail(403, 'forbidden', 'This allocation was made by your reseller and cannot be deleted. Contact them directly.')
  }

  // Live usage BEFORE deleting upstream — it may not be queryable afterward. The session
  // is FROZEN at what it has used first (cap = usage), then read again: traffic that
  // flowed between a plain read and the delete used to vanish from both the archived
  // total and the usage history. If the upstream delete then fails, the real cap is put back.
  let liveUsedGb: number | null = null
  let frozen = false
  if (cred.upstream_sub_user_id) {
    try { liveUsedGb = await getSubUserUsage(cred.upstream_sub_user_id) }
    catch (e) { console.error('[credentials] live usage check failed, falling back to synced gb_used', e) }

    if (liveUsedGb !== null) {
      try {
        await updateSubUserTrafficLimit(cred.upstream_sub_user_id, Math.max(1, Math.ceil(liveUsedGb * 1024)))
        frozen = true
        const settled = await getSubUserUsage(cred.upstream_sub_user_id).catch(() => null)
        if (settled !== null && settled > liveUsedGb) liveUsedGb = settled
      } catch (e) { console.error('[credentials] could not freeze the session before delete (continuing)', id, e) }
    }

    try {
      await deleteSubUser(cred.upstream_sub_user_id)
    } catch (e) {
      if (!isGone(e)) {
        console.error('[credentials] upstream delete failed — nothing changed', id, e)
        // Only an ACTIVE session gets its full cap back. A paused / admin-disabled session was
        // already capped at its usage: restoring gb_allocated would lift that pause or kill.
        // The freeze cap (ceil of live usage) is exactly the pause cap, so it stays.
        if (frozen && cred.status === 'active') {
          try { await updateSubUserTrafficLimit(cred.upstream_sub_user_id, expectedLimitMb(Number(cred.gb_allocated))) }
          catch (e2) { console.error('[credentials] could not restore the cap after a failed delete', id, e2); await markLimitSyncNeeded(admin, id) }
        }
        return fail(502, 'upstream_unavailable', 'Could not remove the proxy upstream. Nothing was changed — please retry shortly.')
      }
    }
  }

  const { data: result, error } = await admin.rpc('delete_own_credential', {
    p_credential_id: id, p_user_id: userId, p_live_used_gb: liveUsedGb,
  })
  if (error) {
    if (error.code === 'P0002') return fail(404, 'not_found', 'Sub-user not found') // lost a race with a concurrent delete
    console.error('[credentials] delete_own_credential failed after upstream delete', id, error)
    return fail(500, 'internal_error', 'The proxy was removed upstream but the record could not be deleted. Retry this request to finish.')
  }

  const released = Number((result as any)?.released_gb ?? 0)
  const used = Number((result as any)?.archived_gb ?? 0)
  // Usage the session consumed since its last sync is credited to the daily history now —
  // the sync can no longer see it once the row is gone.
  await recordUsageDeltas(admin, [{ user_id: userId, gb: used - Number(cred.gb_used ?? 0) }])
  await dispatchWebhook(userId, 'session_deleted', {
    credential_id: id, label: cred.label, gb_allocated: Number(cred.gb_allocated), gb_used: used, gb_released: released, source,
  })
  return { ok: true, data: { gb_released: released, gb_used: used } }
}

// ── Top-up ────────────────────────────────────────────────────────────
// A failed live Upstream PATCH is recorded on the row (last_provision_error =
// LIMIT_SYNC) so the 'provision' cron task retries it, instead of "needs
// manual reconciliation" with nothing watching.
export const LIMIT_SYNC_MARKER = 'LIMIT_SYNC'

export async function markLimitSyncNeeded(admin: Admin, credentialId: string) {
  try {
    await admin.from('proxy_credentials').update({ last_provision_error: LIMIT_SYNC_MARKER }).eq('id', credentialId)
    // First failure of this episode only: the clock the stuck-sync alert measures.
    await admin.from('proxy_credentials').update({ limit_sync_failed_since: new Date().toISOString() })
      .eq('id', credentialId).is('limit_sync_failed_since', null)
  } catch (e) { console.error('[credentials] could not mark limit sync', credentialId, e) }
}

// The live cap now matches the database: end the episode.
export async function clearLimitSyncState(admin: Admin, credentialId: string) {
  try {
    await admin.from('proxy_credentials').update({ limit_sync_failed_since: null, limit_sync_alerted_at: null }).eq('id', credentialId)
    await admin.from('proxy_credentials').update({ last_provision_error: null })
      .eq('id', credentialId).eq('last_provision_error', LIMIT_SYNC_MARKER)
  } catch (e) { console.error('[credentials] could not clear limit sync state', credentialId, e) }
}

export function expectedLimitMb(gbAllocated: number): number {
  return Math.max(1, Math.round(Number(gbAllocated) * 1024))
}

// Brings the provider's live cap in line with the database for ONE credential.
//
//   1. read gb_allocated fresh,  2. PATCH it,  3. read it again — if a
//   concurrent top-up committed while we were talking to Upstream, PATCH the
//   newer value too (bounded to 2 rounds; the usage-sync reconciler heals
//   anything beyond that on the next tick).
//
// On failure the credential is flagged (markLimitSyncNeeded) so the cron
// retry picks it up, and a customer-facing warning string is returned.
export async function syncCredentialLimit(admin: Admin, credentialId: string): Promise<string | null> {
  for (let round = 0; round < 2; round++) {
    const { data: cred } = await admin
      .from('proxy_credentials').select('status, upstream_sub_user_id, gb_allocated, limit_sync_failed_since, last_provision_error')
      .eq('id', credentialId).maybeSingle()
    // 'pending' has no sub-user yet; provisioning reads gb_allocated fresh.
    if (!cred || cred.status !== 'active' || !cred.upstream_sub_user_id) return null

    const sent = Number(cred.gb_allocated)
    try {
      // trafficLimitMB only — NEVER activeUntil (it resets usage upstream).
      await updateSubUserTrafficLimit(cred.upstream_sub_user_id, expectedLimitMb(sent))
    } catch (e) {
      console.error('[credentials] DB committed but Upstream limit PATCH failed — queued for automatic retry', credentialId, e)
      await markLimitSyncNeeded(admin, credentialId)
      return 'Your allocation was updated, but applying it to the live proxy failed. It will be retried automatically; contact support if it doesn\u2019t resolve shortly.'
    }

    // This PATCH landed: any earlier "live cap is behind" episode is over
    // (a later round re-flags it if a newer value then fails).
    if (cred.limit_sync_failed_since || cred.last_provision_error === LIMIT_SYNC_MARKER) await clearLimitSyncState(admin, credentialId)

    const { data: after } = await admin.from('proxy_credentials').select('gb_allocated').eq('id', credentialId).maybeSingle()
    if (!after || Number(after.gb_allocated) === sent) return null // nothing moved underneath us
  }
  return null
}

export async function topupCredential(
  admin: Admin, userId: string, id: string, gb: number, source: 'api' | 'dashboard'
): Promise<CredResult<{ gb_allocated: number; gb_added: number; warning?: string }>> {
  // A malformed id reached the RPC as a uuid parameter and came back as a 500.
  if (!isUuidString(id)) return fail(404, 'not_found', 'Sub-user not found')
  const { data: rawNewTotal, error: topupErr } = await admin.rpc('topup_credential', {
    p_credential_id: id, p_user_id: userId, p_gb: gb,
  })
  if (topupErr) {
    const msg = topupErr.message ?? 'Top-up failed'
    if (msg.includes('Insufficient')) return fail(402, 'insufficient_bandwidth', msg)
    if (topupErr.code === '23514') return fail(400, 'invalid_request', 'A single sub-user can hold at most 100000 GB; this top-up would exceed that.')
    if (topupErr.code === 'P0002' || msg.includes('not found')) return fail(404, 'not_found', 'Sub-user not found')
    if (msg.includes('reseller')) return fail(403, 'forbidden', msg)
    // Only our own RAISE EXCEPTION texts (P0001) are written for customers; any
    // other database error is logged and replaced with a generic message.
    if (topupErr.code !== 'P0001') {
      console.error('[credentials] topup_credential failed', id, topupErr)
      return fail(500, 'internal_error', 'Could not add bandwidth to this session. Please try again.')
    }
    return fail(400, 'invalid_request', msg)
  }

  const newTotal = Number(rawNewTotal)

  // Push the CURRENT database allocation to Upstream — not `newTotal`. Two
  // concurrent top-ups each PATCH an absolute number; if the older request's
  // PATCH lands last the live cap ends up BELOW what the database (and the
  // customer) says, the PATCH "succeeds", and nothing is marked for retry.
  // See syncCredentialLimit for the read-then-write-then-verify sequence.
  const warning = (await syncCredentialLimit(admin, id)) ?? undefined
  const cred = await getOwnedCredential(admin, userId, id, 'label').catch(() => null)

  await dispatchWebhook(userId, 'session_topped_up', {
    credential_id: id, label: cred?.label ?? null, gb_added: gb, gb_allocated: newTotal, source,
  })
  return { ok: true, data: { gb_allocated: newTotal, gb_added: gb, warning } }
}

// ── Pending credentials: provisioning with retries ────────────────────
export async function provisionPendingCredentials(
  opts: { userId?: string; credentialId?: string; limit?: number; ignoreBackoff?: boolean } = {}
): Promise<{ claimed: number; activated: number; failed: number; skipped?: string }> {
  if (!providerConfigured()) return { claimed: 0, activated: 0, failed: 0, skipped: 'provider_not_configured' }
  const admin = await createAdminClient()

  const { data: claimed, error } = await admin.rpc('claim_pending_credentials', {
    p_limit: opts.limit ?? 5, p_user_id: opts.userId ?? null, p_ignore_backoff: opts.ignoreBackoff ?? false,
    p_credential_id: opts.credentialId ?? null,
  })
  if (error) { console.error('[provision] claim failed', error); return { claimed: 0, activated: 0, failed: 0 } }

  let activated = 0
  let failed = 0
  // One supplier listing per run, shared by every adopted identity (was one full listing each).
  const lookup = memoizedSubUserLookup()
  for (const cred of (claimed ?? []) as any[]) {
    try {
      // The upstream identity is decided and SAVED before the supplier is
      // called. If this attempt dies ambiguously (timeout / 5xx after the
      // sub-user was created) the next one re-uses it and adopts that sub-user
      // instead of creating a second one that nobody tracks.
      let identity: UpstreamIdentity
      const hadIdentity = !!(cred.provision_username && cred.provision_password)
      if (hadIdentity) {
        identity = { username: cred.provision_username, password: cred.provision_password }
      } else {
        const fresh = newUpstreamIdentity(cred.id)
        await admin.from('proxy_credentials')
          .update({ provision_username: fresh.username, provision_password: fresh.password })
          .eq('id', cred.id).eq('status', 'pending').is('provision_username', null)
        const { data: saved } = await admin.from('proxy_credentials')
          .select('provision_username, provision_password').eq('id', cred.id).eq('status', 'pending').maybeSingle()
        if (!saved?.provision_username || !saved?.provision_password) throw new Error('credential changed while claiming')
        identity = { username: saved.provision_username, password: saved.provision_password }
      }

      const gcred = await createOrAdoptSubUser({
        label: cred.label ?? `gp_${String(cred.user_id).slice(0, 8)}`,
        gb_limit: cred.gb_allocated,
        country: cred.country ?? undefined, state: cred.state ?? undefined, city: cred.city ?? undefined,
        asn: cred.asn ?? undefined,
        protocol: cred.protocol ?? 'http', session_type: cred.session_type ?? 'rotating',
        sticky_duration: cred.sticky_duration ?? undefined,
      }, identity, { lookupFirst: hadIdentity, lookup })
      if (gcred.adopted) console.warn('[provision] adopted an existing sub-user from an earlier ambiguous attempt', cred.id)

      // Guarded on status='pending': if the credential was deleted (or
      // activated by a racing run) in the meantime, don't resurrect it —
      // remove the sub-user we just made instead of orphaning it.
      const { data: updated, error: updErr } = await admin.from('proxy_credentials').update({
        status: 'active',
        upstream_sub_user_id: gcred.upstream_sub_user_id,
        upstream_username: gcred.username,
        upstream_password: gcred.password,
        host: gcred.host, port: gcred.port,
        activated_at: new Date().toISOString(),
        last_provision_error: null,
        pending_reason: null,
        provision_stalled_at: null,
        provision_username: null,
        provision_password: null,
      }).eq('id', cred.id).eq('status', 'pending').select('id, gb_allocated')

      if (updErr || !updated?.length) {
        if (updErr) console.error('[provision] failed to persist activated credential', cred.id, updErr)
        // A (re-used / adopted) sub-user that ANOTHER row already points at is that
        // row's live proxy — never delete it. Only an unreferenced one is ours to clean up.
        const { count: referenced } = await admin.from('proxy_credentials')
          .select('id', { count: 'exact', head: true }).eq('upstream_sub_user_id', gcred.upstream_sub_user_id)
        if (!referenced) {
          await deleteSubUser(gcred.upstream_sub_user_id).catch((e) =>
            console.error('[provision] FAILED to clean up orphaned sub-user', gcred.upstream_sub_user_id, e))
        }
        failed++
        continue
      }

      // A top-up between claim and now raised gb_allocated past the limit we
      // just created the sub-user with — bring the live cap up to date. (An
      // adopted sub-user may also carry an older limit; the reconciler heals that.)
      const nowAllocated = Number(updated[0].gb_allocated)
      if (nowAllocated !== Number(cred.gb_allocated) || gcred.adopted) {
        try { await updateSubUserTrafficLimit(gcred.upstream_sub_user_id, nowAllocated * 1024) }
        catch { await markLimitSyncNeeded(admin, cred.id) }
      }

      // A re-provisioned session gets its IP whitelist back from the local mirror.
      // A failure is remembered (whitelist_replay_pending) and retried by the cron, instead of the
      // session silently going live with a less restricted list than the customer set.
      await replayWhitelist(admin, cred.id, gcred.upstream_sub_user_id).then(
        () => admin.from('proxy_credentials').update({ whitelist_replay_pending: false }).eq('id', cred.id).eq('whitelist_replay_pending', true).then(() => undefined, () => undefined),
        async (e) => {
          console.error('[provision] whitelist replay failed', cred.id, e)
          await admin.from('proxy_credentials').update({ whitelist_replay_pending: true }).eq('id', cred.id)
            .then(() => undefined, () => undefined)
        })

      activated++
      await dispatchWebhook(cred.user_id, 'session_activated', {
        credential_id: cred.id, label: cred.label, gb_allocated: nowAllocated, status: 'active',
      })
    } catch (e) {
      failed++
      console.error('[provision] failed to activate credential', cred.id, e)
      // Neutral code + reason only — never the raw upstream text.
      try {
        await admin.from('proxy_credentials')
          .update({ last_provision_error: errMsg(e), pending_reason: classifyUpstreamError(e) })
          .eq('id', cred.id).eq('status', 'pending')
      } catch { /* best effort */ }
    }
  }
  return { claimed: claimed?.length ?? 0, activated, failed }
}

// Retries live-limit PATCHes that failed after a committed top-up.
export async function reconcileLimitSync(limit = 5): Promise<{ checked: number; fixed: number }> {
  if (!providerConfigured()) return { checked: 0, fixed: 0 }
  const admin = await createAdminClient()
  const { data: rows } = await admin
    .from('proxy_credentials').select('id, gb_allocated, upstream_sub_user_id')
    .eq('status', 'active').eq('last_provision_error', LIMIT_SYNC_MARKER)
    .not('upstream_sub_user_id', 'is', null).limit(limit)
  let fixed = 0
  for (const r of rows ?? []) {
    try {
      // Re-reads gb_allocated immediately before the PATCH (and verifies after), so
      // a top-up that committed since this select is not overwritten with a stale
      // number; it also clears / re-arms the stuck-sync clock.
      const warning = await syncCredentialLimit(admin, r.id)
      if (!warning) fixed++
    } catch (e) {
      console.error('[provision] limit sync retry failed', r.id, e)
    }
  }
  return { checked: rows?.length ?? 0, fixed }
}

// ── Edit in place ─────────────────────────────────────────────────────
// Label, targeting, protocol, session type, sticky lifetime and endpoint
// count, WITHOUT delete + recreate. Nothing here touches Upstream: targeting
// lives in the connection username and the stored port is a pure function of
// (protocol, session_type). Shared by PATCH /api/v1/sub-users/:id and PATCH
// /api/dashboard/proxies/:id (the dashboard had no edit at all — moving a
// session to another country meant deleting it, the one operation that
// rounds, refunds and archives GB).
//
// Changing the country clears a dependent state/city that the caller didn't
// also send: merging them onto the new country (e.g. country=de with the old
// state=california) produced a username Upstream can't match.
const normGeo = (v: unknown): string | null => {
  if (v === undefined || v === null) return null
  const t = String(v).trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  return t === '' ? null : t
}

export async function updateCredentialSettings(
  admin: Admin, userId: string, id: string, body: unknown, source: 'api' | 'dashboard' = 'api'
): Promise<CredResult<{ cred: any }>> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail(400, 'invalid_request', 'Request body must be a JSON object.')
  }
  const b = body as Record<string, unknown>

  const cred = await getOwnedCredential(admin, userId, id)
  if (!cred) return fail(404, 'not_found', 'Sub-user not found')
  if (cred.created_by) {
    return fail(403, 'forbidden', 'This allocation was made by your reseller and cannot be edited. Contact them directly.')
  }
  if (cred.status === 'suspended') return fail(403, 'forbidden', 'This session is suspended and cannot be edited.')

  const patch: Record<string, unknown> = {}

  if ('label' in b) {
    const label = parseLabel(b.label)
    if (!label.ok) return fail(400, 'invalid_request', label.error)
    patch.label = label.value
  }

  if ('endpoint_count' in b) {
    const n = parseFiniteNumber(b.endpoint_count)
    if (n === null || !Number.isInteger(n) || n < 1 || n > MAX_ENDPOINT_COUNT) {
      return fail(400, 'invalid_request', `endpoint_count must be a whole number between 1 and ${MAX_ENDPOINT_COUNT}.`)
    }
    patch.endpoint_count = n
  }

  if (['country', 'state', 'city', 'asn'].some((k) => k in b)) {
    const countryChanged = 'country' in b && normGeo(b.country) !== (cred.country ?? null)
    const stateChanged = 'state' in b && normGeo(b.state) !== (cred.state ?? null)
    const asnChanged = 'asn' in b && String(b.asn ?? '').trim() !== String(cred.asn ?? '')
    const t = parseTargeting({
      country: 'country' in b ? b.country : cred.country,
      state: 'state' in b ? b.state : (countryChanged ? null : cred.state),
      city: 'city' in b ? b.city : (countryChanged || stateChanged ? null : cred.city),
      asn: 'asn' in b ? b.asn : cred.asn,
      // A legacy ASN that has since left the inventory must not block a
      // relabel; only check it when the ASN or country is actually changing.
    }, { checkAsn: asnChanged || countryChanged })
    if (!t.ok) return fail(400, 'invalid_request', t.error)
    Object.assign(patch, t.value)
  }

  if (['session_type', 'protocol', 'sticky_duration'].some((k) => k in b)) {
    const s = parseSessionOptions(
      { session_type: b.session_type, protocol: b.protocol, sticky_duration: 'sticky_duration' in b ? b.sticky_duration : cred.sticky_duration },
      { session_type: cred.session_type, protocol: cred.protocol }
    )
    if (!s.ok) return fail(400, 'invalid_request', s.error)
    Object.assign(patch, s.value)
    patch.port = getProxyPort(s.value.protocol, s.value.session_type)
  }

  if (Object.keys(patch).length === 0) {
    return fail(400, 'invalid_request', 'No updatable fields provided. Supported: label, country, state, city, asn, session_type, protocol, sticky_duration, endpoint_count.')
  }

  const { data, error } = await admin
    .from('proxy_credentials').update(patch).eq('id', id).eq('user_id', userId).select(CRED_COLS).maybeSingle()
  if (error) {
    console.error('[credentials] updateCredentialSettings failed', id, error)
    return fail(500, 'internal_error', 'Could not update the sub-user.')
  }
  if (!data) return fail(404, 'not_found', 'Sub-user not found')
  await dispatchWebhook(userId, 'session_updated', {
    credential_id: id, label: data.label ?? null, changed: Object.keys(patch).filter((k) => k !== 'port'),
    protocol: data.protocol, session_type: data.session_type, sticky_duration: data.sticky_duration ?? null,
    country: data.country ?? null, state: data.state ?? null, city: data.city ?? null, asn: data.asn ?? null,
    endpoint_count: data.endpoint_count, source,
  })
  return { ok: true, data: { cred: data } }
}

// ── Suspension safety net ─────────────────────────────────────────────
// Suspending an account is done by lib/adminProxy.ts: it caps each live
// sub-user at what it has used and flips the credential to 'suspended'
// (which takes it out of usage sync). That loop is best-effort per
// credential — if one cap call fails, THAT credential stays 'active' and
// keeps serving traffic with nothing to retry it. The usage-sync reconciler
// (lib/usageSync.ts) closes that gap: any credential still 'active' under a
// suspended owner gets the same cap on the next tick. It never touches a
// credential adminProxy already marked 'suspended'.
export const SUSPENDED_CAP_HEADROOM_MB = 1

export function suspendedCapMb(usedMb: number): number {
  return Math.max(1, Math.ceil(usedMb) + SUSPENDED_CAP_HEADROOM_MB)
}

// Ids of every admin-suspended account. A set lookup rather than a PostgREST
// embed: proxy_credentials has TWO foreign keys to profiles (user_id,
// created_by), which makes an unhinted `profiles!inner(...)` ambiguous.
export async function loadSuspendedUserIds(admin: Admin): Promise<Set<string>> {
  const { rows } = await fetchAllRows<{ id: string }>((from, to) =>
    admin.from('profiles').select('id').eq('is_suspended', true).order('id').range(from, to)
  )
  return new Set(rows.map((r) => r.id))
}

// ── Release unused bandwidth ──────────────────────────────────────────
// Hands GB a session hasn't used back to the account balance WITHOUT
// deleting it (the only previous way to reclaim GB was delete, which also
// destroys the endpoint and archives the session's usage).
//
// Safety, in order:
//   • the LIVE usage figure is read from the provider; if that read fails,
//     nothing is released (a stale figure could hand back consumed GB);
//   • the floor is max(live, synced) + 0.05 GB headroom for active sessions;
//   • the provider's cap is lowered BEFORE the database releases the
//     reservation, so released GB can't be consumed and re-spent while the
//     two disagree. If the database step then refuses (a race), the cap is
//     put back to the database value;
//   • the final syncCredentialLimit pass reconciles against a top-up that
//     landed concurrently.
const RELEASE_HEADROOM_GB = 0.05
const round4 = (n: number) => Math.round(n * 10000) / 10000

export async function releaseCredentialBandwidth(
  admin: Admin, userId: string, id: string, gb: number, source: 'api' | 'dashboard'
): Promise<CredResult<{ gb_allocated: number; gb_released: number; max_releasable_gb: number; warning?: string }>> {
  // Checked before anything touches the provider: an amount that rounds below the
  // minimum used to lower the live cap first and only then be refused by the database.
  if (!(gb >= 0.01)) return fail(400, 'invalid_request', 'Release amount must be at least 0.01 GB.')
  const cred = await getOwnedCredential(admin, userId, id, 'id, label, status, gb_allocated, gb_used, upstream_sub_user_id, created_by')
  if (!cred) return fail(404, 'not_found', 'Sub-user not found')
  if (cred.created_by) return fail(403, 'forbidden', 'This allocation was made by your reseller and cannot be changed directly. Contact them.')
  if (cred.status !== 'active' && cred.status !== 'pending') return fail(409, 'conflict', 'Only active or pending sessions can release bandwidth.')

  const isActive = cred.status === 'active' && !!cred.upstream_sub_user_id
  let live: number | null = null
  if (isActive) {
    try { live = await getSubUserUsage(cred.upstream_sub_user_id) }
    catch (e) {
      console.error('[credentials] release: live usage unavailable', id, e)
      return fail(502, 'upstream_unavailable', 'Could not confirm this session\u2019s live usage, so nothing was released. Please retry shortly.')
    }
  }

  const allocated = Number(cred.gb_allocated)
  const used = Math.max(Number(cred.gb_used ?? 0), live ?? 0)
  const headroom = cred.status === 'active' ? RELEASE_HEADROOM_GB : 0
  const maxReleasable = Math.max(0, Math.floor((allocated - used - headroom - 0.01) * 10000) / 10000)
  const target = round4(allocated - gb)
  if (target < used + headroom || target < 0.01) {
    return fail(400, 'invalid_request', maxReleasable >= 0.01
      ? `Only ${maxReleasable} GB can be released from this session right now (the rest is used or held as a safety margin).`
      : 'This session has no unused bandwidth that can be released right now.')
  }

  if (isActive) {
    try { await updateSubUserTrafficLimit(cred.upstream_sub_user_id, expectedLimitMb(target)) }
    catch (e) {
      console.error('[credentials] release: lowering the live cap failed — nothing changed', id, e)
      return fail(502, 'upstream_unavailable', 'Could not update the live proxy limit. Nothing was changed — please retry shortly.')
    }
  }

  const { data: rawTotal, error } = await admin.rpc('release_credential_gb', {
    p_credential_id: id, p_user_id: userId, p_gb: gb, p_live_used_gb: live,
  })
  if (error) {
    // The database refused after we lowered the cap: put the cap back.
    if (isActive) await syncCredentialLimit(admin, id)
    const msg = error.message ?? ''
    if (error.code === 'P0004') return fail(400, 'invalid_request', `${msg}.`)
    if (error.code === 'P0005') return fail(409, 'conflict', msg)
    if (error.code === 'P0002') return fail(404, 'not_found', 'Sub-user not found')
    if (error.code === '42501') return fail(403, 'forbidden', msg)
    if (error.code === '22023') return fail(400, 'invalid_request', msg)
    console.error('[credentials] release_credential_gb failed', id, error)
    return fail(500, 'internal_error', 'Could not release bandwidth. Please try again.')
  }

  const newTotal = Number(rawTotal)
  const warning = (await syncCredentialLimit(admin, id)) ?? undefined
  await dispatchWebhook(userId, 'session_released', {
    credential_id: id, label: cred.label ?? null, gb_released: gb, gb_allocated: newTotal, source,
  })
  return {
    ok: true,
    data: {
      gb_allocated: newTotal, gb_released: gb,
      max_releasable_gb: Math.max(0, Math.floor((newTotal - used - headroom - 0.01) * 10000) / 10000),
      warning,
    },
  }
}

// ── Password rotation ─────────────────────────────────────────────────
// A leaked proxy password used to mean delete + recreate (new endpoint,
// refund rounding, archived usage). This swaps the password in place.
//
// VERIFIED, not gated: the provider's PATCH is only documented to accept the
// fields it takes at creation, so every rotation is confirmed end to end through
// the proxy itself (verifyRotation below) before the new password is committed.
//
// Order: provider first, database second, retried. A database failure after
// the provider accepted is reported as retryable: running the rotation again
// mints a fresh password and applies it to both, which converges.
// Rotation is verified END TO END on every call (see verifyRotation) instead of
// trusting the provider's PATCH response, so it no longer ships dark. It stays on
// unless PASSWORD_ROTATION_ENABLED is set to exactly "false" (kill switch).
export const passwordRotationEnabled = () => process.env.PASSWORD_ROTATION_ENABLED !== 'false'

// 'applied'  — the proxy accepts the new password
// 'ignored'  — the new one is refused while the OLD one still works: the provider
//              silently dropped the change, so it must NOT be committed
// 'unknown'  — neither could be confirmed (warm-up, exhausted session, probe
//              unreachable): the provider echoed the new password, so commit it
async function verifyRotation(host: string, baseUser: string, oldPass: string, newPass: string): Promise<'applied' | 'ignored' | 'unknown'> {
  try {
    const { quickProxyCheck } = await import('@/lib/networkProbe')
    const port = getProxyPort('http', 'rotating')
    const user = buildProxyUsername(baseUser, {})
    if (await quickProxyCheck(host, port, user, newPass)) return 'applied'
    if (await quickProxyCheck(host, port, user, oldPass)) return 'ignored'
  } catch (e) {
    console.error('[credentials] rotate: verification probe failed', e)
  }
  return 'unknown'
}

export async function rotateCredentialPassword(
  admin: Admin, userId: string, id: string
): Promise<CredResult<{ password: string }>> {
  if (!passwordRotationEnabled()) {
    return fail(503, 'upstream_unavailable', 'Password rotation isn\u2019t available right now. Delete and recreate the session in the meantime, or contact support.')
  }
  const cred = await getOwnedCredential(admin, userId, id, 'id, label, status, upstream_sub_user_id, upstream_username, upstream_password, host')
  if (!cred) return fail(404, 'not_found', 'Sub-user not found')
  if (cred.status !== 'active' || !cred.upstream_sub_user_id) {
    return fail(409, 'conflict', 'Only an active session can have its password rotated.')
  }

  const newPassword = crypto.randomUUID() // the provider requires uuid-format passwords
  let confirmedByEcho = false
  try {
    const echoed = await updateSubUserPassword(cred.upstream_sub_user_id, newPassword)
    if (echoed !== null && echoed !== newPassword) {
      console.error('[credentials] rotate: provider echoed a different password — not committing', id)
      if (cred.upstream_password) await updateSubUserPassword(cred.upstream_sub_user_id, cred.upstream_password)
        .catch((e2) => console.error('[credentials] rotate: could not re-assert the previous password', id, e2))
      return fail(502, 'upstream_unavailable', 'The proxy network did not apply the new password. Nothing was changed.')
    }
    confirmedByEcho = echoed === newPassword
  } catch (e) {
    console.error('[credentials] rotate: provider rejected the password change', id, e)
    // A timeout is ambiguous: the change may have been applied after we gave up. Re-assert the
    // stored password so the provider and the database cannot end up on different ones.
    if (cred.upstream_password) await updateSubUserPassword(cred.upstream_sub_user_id, cred.upstream_password)
      .catch(() => { /* the provider is unreachable — nothing more can be done from here */ })
    return fail(502, 'upstream_unavailable', 'Could not change the password right now. Nothing was changed \u2014 please retry shortly.')
  }

  if (cred.upstream_username && cred.upstream_password) {
    const verdict = await verifyRotation(cred.host || PROXY_HOST, cred.upstream_username, cred.upstream_password, newPassword)
    if (verdict === 'ignored') {
      console.error('[credentials] rotate: provider ignored the password change — not committing', id)
      // The provider may only be slow to apply it: left alone, the new password could take
      // effect AFTER this answer and lock the customer out of the one we still store. Put the
      // old one back so both sides converge on it (best effort — it is the password we keep).
      await updateSubUserPassword(cred.upstream_sub_user_id, cred.upstream_password)
        .catch((e) => console.error('[credentials] rotate: could not re-assert the previous password', id, e))
      return fail(502, 'upstream_unavailable', 'The proxy network did not apply the new password. Nothing was changed.')
    }
    if (verdict === 'unknown') {
      if (!confirmedByEcho) {
        // Neither an echo nor a probe confirmed it: committing could hand the customer a password
        // that does not work. Put the old one back so both sides converge on it.
        console.error('[credentials] rotate: new password unconfirmed (no echo, probe inconclusive) — not committing', id)
        await updateSubUserPassword(cred.upstream_sub_user_id, cred.upstream_password)
          .catch((e) => console.error('[credentials] rotate: could not re-assert the previous password', id, e))
        return fail(502, 'upstream_unavailable', 'We could not confirm the new password was applied. Nothing was changed \u2014 please retry shortly.')
      }
      console.warn('[credentials] rotate: could not verify the new password end to end — committing on the provider echo', id)
    }
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const { error } = await admin.from('proxy_credentials')
      .update({ upstream_password: newPassword }).eq('id', id).eq('user_id', userId)
    if (!error) {
      await dispatchWebhook(userId, 'session_password_rotated', { credential_id: id, label: cred.label ?? null })
      return { ok: true, data: { password: newPassword } }
    }
    console.error('[credentials] rotate: saving the new password failed', id, attempt, error.code)
  }
  // The new password could not be saved: put the OLD one back upstream so the customer's
  // stored (and working) password stays valid, then re-check it end to end.
  if (cred.upstream_password) {
    try {
      await updateSubUserPassword(cred.upstream_sub_user_id, cred.upstream_password)
      const verdict = cred.upstream_username
        ? await verifyRotation(cred.host || PROXY_HOST, cred.upstream_username, newPassword, cred.upstream_password)
        : 'unknown'
      if (verdict !== 'ignored') {
        return fail(500, 'internal_error', 'The password could not be changed. Nothing was changed \u2014 please retry.')
      }
    } catch (e) { console.error('[credentials] rotate: could not restore the previous password', id, e) }
  }
  return fail(500, 'internal_error', 'The password was changed but could not be saved. Run the rotation again to finish \u2014 the previous password may no longer work.')
}

// ── Live cap stuck behind the database ────────────────────────────────
// A committed top-up / auto-allocate / release whose live-cap PATCH keeps
// failing leaves the dashboard showing the new allocation while the session is
// still cut off at the old cap. Nothing else notices: the exhaustion notice
// compares usage to the DATABASE allocation. After STUCK_LIMIT_AFTER_MIN the
// owner (supplier-neutral wording) and the admin are told once per episode.
const STUCK_LIMIT_AFTER_MIN = 30
const MAX_STUCK_NOTICES_PER_RUN = 10

export async function alertStuckLimitSync(admin: Admin): Promise<{ alerted: number }> {
  const cutoff = new Date(Date.now() - STUCK_LIMIT_AFTER_MIN * 60_000).toISOString()
  const { data: due } = await admin
    .from('proxy_credentials').select('id')
    .eq('status', 'active').not('limit_sync_failed_since', 'is', null)
    .lt('limit_sync_failed_since', cutoff).is('limit_sync_alerted_at', null)
    .limit(MAX_STUCK_NOTICES_PER_RUN)
  if (!due?.length) return { alerted: 0 }

  // Claim by flagging first: a duplicate email is worse than a late one.
  const { data: claimed } = await admin
    .from('proxy_credentials').update({ limit_sync_alerted_at: new Date().toISOString() })
    .in('id', due.map((d: any) => d.id)).is('limit_sync_alerted_at', null)
    .select('id, user_id, label, gb_allocated')
  if (!claimed?.length) return { alerted: 0 }

  const suspended = await loadSuspendedUserIds(admin)
  for (const c of claimed as any[]) {
    if (suspended.has(c.user_id)) continue
    const { data: profile } = await admin.from('profiles').select('email, full_name').eq('id', c.user_id).single()
    if (!profile?.email) continue
    await sendEmail({
      to: profile.email,
      subject: 'A bandwidth change on your proxy session is delayed — GlobProxy',
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;">
          <h2 style="text-align:center;color:#111;">Your last bandwidth change is delayed</h2>
          <p style="color:#444;text-align:center;">
            Hi ${escapeHtml(profile.full_name?.split(' ')[0]) || 'there'}, the bandwidth change on your session
            <strong>${escapeHtml(c.label || 'Unnamed')}</strong> (${Number(c.gb_allocated).toFixed(2)} GB) is saved on your
            account, but applying it to the live proxy is taking longer than expected. Until it applies, the session
            may stop at its previous limit. We have been alerted and it will apply automatically — no action is needed.
          </p>
          <div style="text-align:center;margin:32px 0;">
            <a href="${appUrl()}/dashboard/proxies"
               style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
              Open my sessions →
            </a>
          </div>
        </div>`,
    }).catch((e) => console.error('[provision] stuck-limit customer email failed', c.id, e))
  }

  if (process.env.ADMIN_EMAIL) {
    await sendEmail({
      to: process.env.ADMIN_EMAIL,
      subject: `[LIVE CAP BEHIND] ${claimed.length} session(s) could not be updated upstream for over ${STUCK_LIMIT_AFTER_MIN} min`,
      html: `<p>${claimed.length} active session(s) have a committed allocation the proxy provider has not accepted for more than
             ${STUCK_LIMIT_AFTER_MIN} minutes (the limit PATCH keeps failing — usually provider stock too low to raise a cap, or an
             API outage). Their customers have been told it is delayed; the sessions may be stopped at the OLD cap.</p>
             <p>Credential ids: ${escapeHtml(claimed.slice(0, 20).map((c: any) => c.id).join(', '))}</p>`,
    }).catch((e) => console.error('[provision] stuck-limit admin alert failed', e))
  }
  return { alerted: claimed.length }
}

// ── Stalled provisioning ──────────────────────────────────────────────
// A pending session is retried forever (slowly), but until now nobody was
// told when that was taking days. After STALL_AFTER_HOURS the cron flags it
// once: the customer gets a calm "reserved, delayed, you can delete it for a
// refund of the bandwidth" email, and the admin gets one summary email.
const STALL_AFTER_HOURS = 6
const MAX_STALL_NOTICES_PER_RUN = 10

export async function flagStalledPending(admin: Admin): Promise<{ flagged: number }> {
  const cutoff = new Date(Date.now() - STALL_AFTER_HOURS * 3_600_000).toISOString()
  const { data: due } = await admin
    .from('proxy_credentials').select('id')
    .eq('status', 'pending').is('created_by', null).is('provision_stalled_at', null)
    // Measured from when it LAST became pending (a re-provisioned old session starts a fresh
    // clock); rows from before migration 0087 have no pending_since and fall back to created_at.
    .or(`pending_since.lt.${cutoff},and(pending_since.is.null,created_at.lt.${cutoff})`)
    .order('created_at').limit(MAX_STALL_NOTICES_PER_RUN)
  if (!due?.length) return { flagged: 0 }

  // Claim by flagging first: a duplicate email is worse than a late one.
  const { data: claimed } = await admin
    .from('proxy_credentials').update({ provision_stalled_at: new Date().toISOString() })
    .in('id', due.map((d: any) => d.id)).is('provision_stalled_at', null)
    .select('id, user_id, label, gb_allocated, pending_reason')
  if (!claimed?.length) return { flagged: 0 }

  const suspended = await loadSuspendedUserIds(admin)
  for (const c of claimed as any[]) {
    if (suspended.has(c.user_id)) continue
    const { data: profile } = await admin.from('profiles').select('email, full_name').eq('id', c.user_id).single()
    if (!profile?.email) continue
    await sendEmail({
      to: profile.email,
      subject: 'Your proxy session is taking longer than expected — GlobProxy',
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;">
          <h2 style="text-align:center;color:#111;">Your session is delayed</h2>
          <p style="color:#444;text-align:center;">
            Hi ${escapeHtml(profile.full_name?.split(' ')[0]) || 'there'}, your session
            <strong>${escapeHtml(c.label || 'Unnamed')}</strong> (${Number(c.gb_allocated).toFixed(2)} GB) hasn't
            come online yet. Your bandwidth is reserved and nothing has been lost; we've been alerted and
            it will activate automatically as soon as capacity is available. If you'd rather not wait you can
            delete it from your dashboard and the full bandwidth returns to your balance.
          </p>
          <div style="text-align:center;margin:32px 0;">
            <a href="${appUrl()}/dashboard/proxies"
               style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
              Open my sessions →
            </a>
          </div>
        </div>`,
    }).catch((e) => console.error('[provision] stalled-session email failed', c.id, e))
  }

  if (process.env.ADMIN_EMAIL) {
    const byReason = claimed.reduce((m: Record<string, number>, c: any) => {
      const k = c.pending_reason ?? 'unknown'; m[k] = (m[k] ?? 0) + 1; return m
    }, {})
    await sendEmail({
      to: process.env.ADMIN_EMAIL,
      subject: `[STALLED PROVISIONING] ${claimed.length} session(s) pending for over ${STALL_AFTER_HOURS}h`,
      html: `<p>${claimed.length} customer session(s) have been pending for more than ${STALL_AFTER_HOURS} hours and the
             customers have been emailed. Reasons: <code>${escapeHtml(JSON.stringify(byReason))}</code>
             (<code>capacity</code> = replenish provider stock; <code>unavailable</code> = provider outage;
             <code>error</code> = check the worker logs).</p>
             <p>Credential ids: ${escapeHtml(claimed.slice(0, 20).map((c: any) => c.id).join(', '))}</p>`,
    }).catch((e) => console.error('[provision] stalled admin alert failed', e))
  }
  return { flagged: claimed.length }
}
