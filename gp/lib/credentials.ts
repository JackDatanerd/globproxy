import { createAdminClient } from '@/lib/supabase/server'
import {
  createSubUser, deleteSubUser, getSubUserUsage, updateSubUserTrafficLimit, GeonodeApiError,
} from '@/lib/geonode'
import { buildProxyUsername, getProxyPort } from '@/lib/proxyEndpoint'
import { dispatchWebhook } from '@/lib/webhooks'
import { fetchAllRows } from '@/lib/dbPaging'
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

export type CredErrorCode =
  | 'invalid_request' | 'not_found' | 'forbidden' | 'conflict'
  | 'insufficient_bandwidth' | 'upstream_unavailable' | 'internal_error'
export type CredFail = { ok: false; status: number; code: CredErrorCode; message: string }
export type CredResult<T> = { ok: true; data: T } | CredFail
const fail = (status: number, code: CredErrorCode, message: string): CredFail => ({ ok: false, status, code, message })

export function providerConfigured(): boolean {
  return !!(process.env.GEONODE_API_KEY && process.env.GEONODE_RESELLER_ID)
}

// Mirrors enforce_credential_limit() (migration 0046).
export const MAX_CREDENTIALS_PER_ACCOUNT = 100

export const CRED_COLS =
  'id, label, status, gb_allocated, gb_used, country, state, city, asn, session_type, protocol, sticky_duration, endpoint_count, host, port, upstream_username, upstream_password, activated_at, created_at, created_by, auto_topup_enabled, auto_topup_threshold_gb, auto_topup_amount_gb'

// Public API shape for a credential. `password` is returned because the
// credential is unusable without it (the dashboard reads the same column
// directly) — treat API keys with the same care as the passwords they expose.
export function toApiCredential(c: any) {
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
    host: c.host, port: c.port,
    username: c.upstream_username, // raw proxy username
    // NOTE: a legacy `upstream_username` alias used to be returned here. It named
    // our upstream supplier to every API customer, so it was removed — use
    // `username` (or, better, `connection_username`).
    password: c.upstream_password ?? null,
    // The username to put in the proxy connection string — includes the
    // country/state/city/ASN/session targeting suffixes.
    connection_username: c.upstream_username ? buildProxyUsername(c.upstream_username, c) : null,
    auto_topup: {
      enabled: !!c.auto_topup_enabled,
      threshold_gb: c.auto_topup_threshold_gb ?? null,
      amount_gb: c.auto_topup_amount_gb ?? null,
    },
    activated_at: c.activated_at,
    created_at: c.created_at,
  }
}

export async function getOwnedCredential(admin: Admin, userId: string, id: string, cols = CRED_COLS) {
  const { data } = await admin.from('proxy_credentials').select(cols).eq('id', id).eq('user_id', userId).maybeSingle()
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
const isGone = (e: unknown) => e instanceof GeonodeApiError && e.status === 404

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
    if (existing) return { ok: true, data: { cred: existing, replayed: true } }
  }

  // Soft pre-check of the per-account cap (the database trigger from
  // migration 0046 is the authoritative, race-free enforcement). Without
  // this a user at the cap would reserve bandwidth and create a real Geonode
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

  const release = async (why: string) => {
    const { error } = await admin.rpc('release_credential_bandwidth', { p_user_id: userId, p_gb: gb })
    if (error) console.error(`[credentials] FAILED to release ${gb}GB reservation after ${why} — needs manual reconciliation`, userId, error)
  }

  try {
    // 2. Geonode. A failure leaves the credential 'pending' (the reservation
    // stands); the 'provision' cron task retries it with backoff.
    let gcred: Awaited<ReturnType<typeof createSubUser>> | null = null
    let status: 'active' | 'pending' = 'pending'
    let provisionError: string | null = null
    if (providerConfigured()) {
      try {
        gcred = await createSubUser({
          label: input.label ?? `gp_${Date.now()}`,
          gb_limit: gb,
          country: input.country ?? undefined, state: input.state ?? undefined, city: input.city ?? undefined,
          asn: input.asn ?? undefined,
          protocol: input.protocol, session_type: input.session_type,
          sticky_duration: input.sticky_duration ?? undefined,
        })
        status = 'active'
      } catch (e) {
        provisionError = errMsg(e)
        console.error('[credentials] Geonode createSubUser failed — leaving credential pending:', e)
      }
    } else {
      provisionError = 'Provider not configured'
    }

    // 3. Persist
    const { data: cred, error: insertErr } = await admin
      .from('proxy_credentials')
      .insert({
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
        // A pending credential is retried by the 'provision' cron task with
        // backoff measured from this first attempt.
        provisioning_claimed_at: status === 'pending' ? new Date().toISOString() : null,
        provision_attempts: status === 'pending' ? 1 : 0,
        last_provision_error: status === 'pending' ? provisionError : null,
        idempotency_key: idemKey,
      })
      .select(CRED_COLS)
      .single()

    if (insertErr || !cred) {
      console.error('[credentials] insert failed', insertErr)
      if (gcred) {
        await deleteSubUser(gcred.upstream_sub_user_id).catch((e) =>
          console.error('[credentials] FAILED to clean up orphaned Geonode sub-user', gcred?.upstream_sub_user_id, e))
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
    // Anything unexpected after the reservation: give it back.
    console.error('[credentials] unexpected error during create', e)
    await release('unexpected error')
    return fail(500, 'internal_error', 'Internal error. Please try again.')
  }
}

// ── Delete ────────────────────────────────────────────────────────────
// Ordering guarantees (shared with the dashboard route and DELETE
// /api/v1/sub-users/:id):
//   1. the upstream (Geonode) delete must succeed — or the sub-user already
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

  // Live usage BEFORE deleting upstream — it may not be queryable afterward.
  let liveUsedGb: number | null = null
  if (cred.upstream_sub_user_id) {
    try { liveUsedGb = await getSubUserUsage(cred.upstream_sub_user_id) }
    catch (e) { console.error('[credentials] live usage check failed, falling back to synced gb_used', e) }

    try {
      await deleteSubUser(cred.upstream_sub_user_id)
    } catch (e) {
      if (!isGone(e)) {
        console.error('[credentials] upstream delete failed — nothing changed', id, e)
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
  await dispatchWebhook(userId, 'session_deleted', {
    credential_id: id, label: cred.label, gb_allocated: Number(cred.gb_allocated), gb_used: used, gb_released: released, source,
  })
  return { ok: true, data: { gb_released: released, gb_used: used } }
}

// ── Top-up ────────────────────────────────────────────────────────────
// A failed live Geonode PATCH is recorded on the row (last_provision_error =
// LIMIT_SYNC) so the 'provision' cron task retries it, instead of "needs
// manual reconciliation" with nothing watching.
export const LIMIT_SYNC_MARKER = 'LIMIT_SYNC'

export async function markLimitSyncNeeded(admin: Admin, credentialId: string) {
  try { await admin.from('proxy_credentials').update({ last_provision_error: LIMIT_SYNC_MARKER }).eq('id', credentialId) }
  catch (e) { console.error('[credentials] could not mark limit sync', credentialId, e) }
}

export function expectedLimitMb(gbAllocated: number): number {
  return Math.max(1, Math.round(Number(gbAllocated) * 1024))
}

// Brings Geonode's live cap in line with the database for ONE credential.
//
//   1. read gb_allocated fresh,  2. PATCH it,  3. read it again — if a
//   concurrent top-up committed while we were talking to Geonode, PATCH the
//   newer value too (bounded to 2 rounds; the usage-sync reconciler heals
//   anything beyond that on the next tick).
//
// On failure the credential is flagged (markLimitSyncNeeded) so the cron
// retry picks it up, and a customer-facing warning string is returned.
export async function syncCredentialLimit(admin: Admin, credentialId: string): Promise<string | null> {
  for (let round = 0; round < 2; round++) {
    const { data: cred } = await admin
      .from('proxy_credentials').select('status, upstream_sub_user_id, gb_allocated')
      .eq('id', credentialId).maybeSingle()
    // 'pending' has no sub-user yet; provisioning reads gb_allocated fresh.
    if (!cred || cred.status !== 'active' || !cred.upstream_sub_user_id) return null

    const sent = Number(cred.gb_allocated)
    try {
      // trafficLimitMB only — NEVER activeUntil (it resets usage upstream).
      await updateSubUserTrafficLimit(cred.upstream_sub_user_id, expectedLimitMb(sent))
    } catch (e) {
      console.error('[credentials] DB committed but Geonode limit PATCH failed — queued for automatic retry', credentialId, e)
      await markLimitSyncNeeded(admin, credentialId)
      return 'Your balance was reserved and the allocation increased, but updating the live proxy limit failed. It will be retried automatically; contact support if it doesn\u2019t resolve shortly.'
    }

    const { data: after } = await admin.from('proxy_credentials').select('gb_allocated').eq('id', credentialId).maybeSingle()
    if (!after || Number(after.gb_allocated) === sent) return null // nothing moved underneath us
  }
  return null
}

export async function topupCredential(
  admin: Admin, userId: string, id: string, gb: number, source: 'api' | 'dashboard'
): Promise<CredResult<{ gb_allocated: number; gb_added: number; warning?: string }>> {
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

  // Push the CURRENT database allocation to Geonode — not `newTotal`. Two
  // concurrent top-ups each PATCH an absolute number; if the older request's
  // PATCH lands last the live cap ends up BELOW what the database (and the
  // customer) says, the PATCH "succeeds", and nothing is marked for retry.
  // See syncCredentialLimit for the read-then-write-then-verify sequence.
  const warning = (await syncCredentialLimit(admin, id)) ?? undefined
  const cred = await getOwnedCredential(admin, userId, id, 'label')

  await dispatchWebhook(userId, 'session_topped_up', {
    credential_id: id, label: cred?.label ?? null, gb_added: gb, gb_allocated: newTotal, source,
  })
  return { ok: true, data: { gb_allocated: newTotal, gb_added: gb, warning } }
}

// ── Pending credentials: provisioning with retries ────────────────────
export async function provisionPendingCredentials(
  opts: { userId?: string; limit?: number; ignoreBackoff?: boolean } = {}
): Promise<{ claimed: number; activated: number; failed: number; skipped?: string }> {
  if (!providerConfigured()) return { claimed: 0, activated: 0, failed: 0, skipped: 'provider_not_configured' }
  const admin = await createAdminClient()

  const { data: claimed, error } = await admin.rpc('claim_pending_credentials', {
    p_limit: opts.limit ?? 5, p_user_id: opts.userId ?? null, p_ignore_backoff: opts.ignoreBackoff ?? false,
  })
  if (error) { console.error('[provision] claim failed', error); return { claimed: 0, activated: 0, failed: 0 } }

  let activated = 0
  let failed = 0
  for (const cred of (claimed ?? []) as any[]) {
    try {
      const gcred = await createSubUser({
        label: cred.label ?? `gp_${String(cred.user_id).slice(0, 8)}`,
        gb_limit: cred.gb_allocated,
        country: cred.country ?? undefined, state: cred.state ?? undefined, city: cred.city ?? undefined,
        asn: cred.asn ?? undefined,
        protocol: cred.protocol ?? 'http', session_type: cred.session_type ?? 'rotating',
        sticky_duration: cred.sticky_duration ?? undefined,
      })

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
      }).eq('id', cred.id).eq('status', 'pending').select('id, gb_allocated')

      if (updErr || !updated?.length) {
        if (updErr) console.error('[provision] failed to persist activated credential', cred.id, updErr)
        await deleteSubUser(gcred.upstream_sub_user_id).catch((e) =>
          console.error('[provision] FAILED to clean up orphaned sub-user', gcred.upstream_sub_user_id, e))
        failed++
        continue
      }

      // A top-up between claim and now raised gb_allocated past the limit we
      // just created the sub-user with — bring the live cap up to date.
      const nowAllocated = Number(updated[0].gb_allocated)
      if (nowAllocated !== Number(cred.gb_allocated)) {
        try { await updateSubUserTrafficLimit(gcred.upstream_sub_user_id, nowAllocated * 1024) }
        catch { await markLimitSyncNeeded(admin, cred.id) }
      }

      activated++
      await dispatchWebhook(cred.user_id, 'session_activated', {
        credential_id: cred.id, label: cred.label, gb_allocated: nowAllocated, status: 'active',
      })
    } catch (e) {
      failed++
      console.error('[provision] failed to activate credential', cred.id, e)
      try { await admin.from('proxy_credentials').update({ last_provision_error: errMsg(e) }).eq('id', cred.id) } catch { /* best effort */ }
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
      await updateSubUserTrafficLimit(r.upstream_sub_user_id!, Number(r.gb_allocated) * 1024)
      await admin.from('proxy_credentials').update({ last_provision_error: null })
        .eq('id', r.id).eq('last_provision_error', LIMIT_SYNC_MARKER)
      fixed++
    } catch (e) {
      console.error('[provision] limit sync retry failed', r.id, e)
    }
  }
  return { checked: rows?.length ?? 0, fixed }
}

// ── Edit in place ─────────────────────────────────────────────────────
// Label, targeting, protocol, session type, sticky lifetime and endpoint
// count, WITHOUT delete + recreate. Nothing here touches Geonode: targeting
// lives in the connection username and the stored port is a pure function of
// (protocol, session_type). Shared by PATCH /api/v1/sub-users/:id and PATCH
// /api/dashboard/proxies/:id (the dashboard had no edit at all — moving a
// session to another country meant deleting it, the one operation that
// rounds, refunds and archives GB).
//
// Changing the country clears a dependent state/city that the caller didn't
// also send: merging them onto the new country (e.g. country=de with the old
// state=california) produced a username Geonode can't match.
const normGeo = (v: unknown): string | null => {
  if (v === undefined || v === null) return null
  const t = String(v).trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  return t === '' ? null : t
}

export async function updateCredentialSettings(
  admin: Admin, userId: string, id: string, body: unknown
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
    const t = parseTargeting({
      country: 'country' in b ? b.country : cred.country,
      state: 'state' in b ? b.state : (countryChanged ? null : cred.state),
      city: 'city' in b ? b.city : (countryChanged || stateChanged ? null : cred.city),
      asn: 'asn' in b ? b.asn : cred.asn,
    })
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
