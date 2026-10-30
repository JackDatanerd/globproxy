import { getProxyPort } from '@/lib/proxyEndpoint'
import { leaksSupplier } from '@/lib/supplierGuard'

const BASE = 'https://app-api.geonode.com/api/reseller/v2'
const KEY = (process.env.UPSTREAM_API_KEY ?? process.env.GEONODE_API_KEY)!
const RESELLER_ID = (process.env.UPSTREAM_RESELLER_ID ?? process.env.GEONODE_RESELLER_ID)!
// Preferred names first; the legacy secret names keep working until the Worker and
// GitHub secrets have been renamed (see FIX_PACKAGE_edge-pipeline-pass8.md).
export function upstreamConfigured(): boolean {
  return !!((process.env.UPSTREAM_API_KEY ?? process.env.GEONODE_API_KEY) && (process.env.UPSTREAM_RESELLER_ID ?? process.env.GEONODE_RESELLER_ID))
}

const SERVICE_TYPE = 'RESIDENTIAL-PREMIUM'

// White-label host — always expose this to users, never the provider's own host
export const PROXY_HOST = 'proxy.globproxy.com'

// Confirmed against the live OpenAPI spec (the provider's reseller API docs):
// the header is a literal custom header, NOT "r-api-key" and NOT "Authorization: Bearer".
// Both of those were tried and failed (401 "Authorization is not provided" /
// "Invalid or expired JWT token") before this was confirmed from the real spec.
function headers() {
  return {
    'Reseller-Api-Key': KEY,
    'Content-Type': 'application/json',
  }
}

// 4 decimals (~0.1 MB). This used to round to 0.01 GB (~10 MB), which made
// sub-5 MB usage read as exactly 0 and let up to ~5 MB per delete/recreate
// cycle go unaccounted for in the refund calculation.
function mbToGb(mb: number): number {
  return Math.round((mb / 1024) * 10000) / 10000
}

// Every Upstream call goes through this. Without a timeout a hung upstream
// holds the Worker open until the platform kills it — and createCredential
// has a bandwidth reservation committed by then (a kill between the reserve
// and the insert leaks it permanently).
const REQUEST_TIMEOUT_MS = 12_000
async function gfetchOnce(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    // The timer is deliberately NOT cleared once the headers arrive: the abort signal also covers
    // reading the body, so a provider that sends headers and then stalls cannot hold the request
    // (and a reservation behind it) open until the platform kills the Worker. Firing after the body
    // has been read is a no-op. Only a failed fetch clears it.
    return await fetch(url, { ...init, signal: ctrl.signal })
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

// Every customer's calls share ONE reseller key, so the provider's rate limit is
// shared too. A 429 means "not processed", which makes a single short retry safe
// for every method (and the bodies sent here are strings, so they can be re-sent).
// Capped at 2s so a throttled provider cannot hold a Worker request open.
async function gfetch(url: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const res = await gfetchOnce(url, init, timeoutMs)
  if (res.status !== 429) return res
  const retryAfter = Number(res.headers.get('retry-after'))
  const waitMs = Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000, 2000) + Math.floor(Math.random() * 250)
  console.warn('[upstream] rate limited (429) — retrying once after', waitMs, 'ms')
  await new Promise((r) => setTimeout(r, waitMs))
  return gfetchOnce(url, init, timeoutMs)
}

// Spec requires password to be uuid-formatted, not an arbitrary string —
// the previous genPassword() (16 random chars) would 400 once auth worked.
function genPassword(): string {
  return crypto.randomUUID()
}

export interface GCred {
  upstream_sub_user_id: string
  username: string
  password: string
  host: string
  port: number
  protocol: string
}

export interface CreateSubUserParams {
  label: string
  gb_limit: number
  // NOTE: the provider's sub-user creation endpoint does not accept country, state,
  // city, protocol, or session_type — confirmed from the live spec, which only
  // takes username/password/trafficLimitMB/activeUntil/email. Upstream applies
  // geo-targeting and session control by suffixing options onto the username
  // at connection time (e.g. "user-country-us-session-abc123"), not at
  // creation time. These fields are accepted here so calling code doesn't
  // need to change yet, but they are currently NOT sent to Upstream and NOT
  // applied anywhere. If GlobProxy needs per-credential targeting to actually
  // work, the connection-string builder (wherever proxy.globproxy.com
  // credentials are displayed/exported to the customer) needs to encode these
  // into the username instead — that's a product decision, flagging rather
  // than guessing at it here.
  country?: string
  state?: string
  city?: string
  asn?: string | number
  protocol?: 'http' | 'socks5'
  session_type?: 'rotating' | 'sticky'
  sticky_duration?: number // minutes
}

// The upstream identity of a credential, decided BEFORE the supplier is called
// and persisted on the row (proxy_credentials.provision_username/password,
// migration 0062). A retry after an ambiguous failure (timeout / 5xx after the
// sub-user was in fact created) re-uses it and can ADOPT the sub-user that
// already exists instead of creating a second, orphaned one that holds a full
// traffic limit out of the reseller pool. The `gp_` prefix is what the orphan
// sweep keys on.
export interface UpstreamIdentity { username: string; password: string }

export function newUpstreamIdentity(credentialId: string): UpstreamIdentity {
  return { username: `gp_${credentialId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20).toLowerCase()}`, password: genPassword() }
}

export async function createSubUser(p: CreateSubUserParams, identity?: UpstreamIdentity): Promise<GCred> {
  // Without a caller-supplied identity (legacy callers / the debug probe):
  // Date.now() alone is millisecond-resolution and can collide under load, so
  // a few random hex bytes are added.
  const username = identity?.username ?? `gp_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`
  const password = identity?.password ?? genPassword()
  // Previously: p.protocol === 'socks5' ? 7000 : 9000 — wrong on two counts.
  // SOCKS5 isn't 7000 (unverified guess), and neither number accounted for
  // sticky vs rotating at all. See lib/proxyEndpoint.ts for the confirmed values.
  const port = getProxyPort(p.protocol, p.session_type)

  // A limit that rounds to 0 MB must never reach Upstream: depending on the
  // provider's semantics 0 can mean "unlimited". The validators enforce a
  // 0.01 GB minimum; this is the backstop for any caller that skips them.
  const trafficLimitMB = Math.round(p.gb_limit * 1024)
  if (!Number.isFinite(trafficLimitMB) || trafficLimitMB < 1) {
    throw new Error(`Refusing to create a sub-user with an invalid traffic limit (${p.gb_limit} GB)`)
  }

  const res = await gfetch(`${BASE}/${RESELLER_ID}/services/${SERVICE_TYPE}/sub-users`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      username,
      password,
      trafficLimitMB,
      // activeUntil / email omitted — both optional per spec
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    // UpstreamApiError so callers can classify the failure (capacity vs auth
    // vs outage) without regex-parsing a message string.
    throw new UpstreamApiError(`Upstream createSubUser failed: ${res.status} ${JSON.stringify(err)}`, res.status, err)
  }

  const d = await res.json()
  const result = d.result ?? d.data ?? d

  // Previously fell back to the username when Upstream returned no id. Every
  // later PATCH/DELETE/usage call is keyed on the numeric id, so a username
  // there silently 404s forever. Fail loudly instead; the orphan sweep in
  // usage sync surfaces the sub-user that was created.
  if (result?.id === undefined || result?.id === null || result?.id === '') {
    console.error('Upstream createSubUser returned no id for', username, JSON.stringify(d))
    throw new Error('Upstream createSubUser returned no sub-user id')
  }

  // The username we asked for is neutral ("gp_…"). If the provider hands back one that
  // NAMES it (a prefix it adds on its side), it would be stored and shown to the
  // customer as their proxy username — so it is refused here. The sub-user that was
  // just created upstream is deleted first: a retry could not find it by our name
  // and would otherwise create another one every time.
  if (leaksSupplier(result.username) && !leaksSupplier(username)) {
    console.error('[supplier-guard] provider returned a username that names the supplier for upstream sub-user', String(result.id), '— refusing to store it')
    try { await deleteSubUser(String(result.id)) } catch (e) {
      console.error('[supplier-guard] could not delete the refused upstream sub-user', String(result.id), '— delete it by hand', e)
    }
    throw new UpstreamApiError('provider returned an unusable sub-user identity', 502, {})
  }

  return {
    upstream_sub_user_id: String(result.id),
    username: result.username ?? username,
    password: result.password ?? password,
    host: PROXY_HOST,
    port,
    protocol: p.protocol ?? 'http',
  }
}

// 400/409/422 whose text says the username is taken. The provider's wording is
// not documented, so this is deliberately loose; a false positive only costs one
// listing, and adoption still requires an exact username match.
export function isDuplicateSubUserError(e: unknown): boolean {
  if (!(e instanceof UpstreamApiError)) return false
  if (e.status === 409) return true
  if (e.status !== 400 && e.status !== 422) return false
  const msg = JSON.stringify(e.body ?? '') + ' ' + e.message
  return /exist|already|taken|duplicate|in use|unique/i.test(msg)
}

// Finds a sub-user by its exact username in the full listing. `complete: false`
// means the listing could not be read in full, so "not found" is NOT a verdict.
export async function findSubUserByUsername(username: string): Promise<{ id: string | null; complete: boolean }> {
  const { subUsers, complete } = await listAllSubUsers()
  for (const [id, snap] of subUsers) if (snap.username === username) return { id, complete: true }
  return { id: null, complete }
}

function adoptedCred(id: string, identity: UpstreamIdentity, p: CreateSubUserParams, username?: string | null): GCred {
  return {
    upstream_sub_user_id: id,
    username: username ?? identity.username,
    password: identity.password,
    host: PROXY_HOST,
    port: getProxyPort(p.protocol, p.session_type),
    protocol: p.protocol ?? 'http',
  }
}

// Create the sub-user — or adopt the one an earlier ambiguous attempt already
// made. lookupFirst (retries, attempt > 1) checks the listing BEFORE creating;
// if the listing is incomplete the attempt is aborted as 'unavailable' rather
// than risking a second sub-user. A duplicate-name rejection on create also
// falls back to adoption.
//
// `lookup` lets a batch caller (provisionPendingCredentials, up to 5 sessions per
// tick) share ONE listing between all its sessions instead of walking the whole
// account once per session: each full listing is up to hundreds of subrequests. The
// duplicate-name fallback always reads a FRESH listing — it exists precisely because
// something was created a moment ago.
export type SubUserLookup = (username: string) => Promise<{ id: string | null; complete: boolean }>

export async function createOrAdoptSubUser(
  p: CreateSubUserParams, identity: UpstreamIdentity, opts: { lookupFirst?: boolean; lookup?: SubUserLookup } = {}
): Promise<GCred & { adopted: boolean }> {
  if (opts.lookupFirst) {
    const found = await (opts.lookup ?? findSubUserByUsername)(identity.username)
    if (found.id) return { ...adoptedCred(found.id, identity, p), adopted: true }
    if (!found.complete) throw new UpstreamApiError('sub-user listing incomplete — not creating blind', 503, {})
  }
  try {
    return { ...(await createSubUser(p, identity)), adopted: false }
  } catch (e) {
    if (isDuplicateSubUserError(e)) {
      const found = await findSubUserByUsername(identity.username)
      if (found.id) return { ...adoptedCred(found.id, identity, p), adopted: true }
    }
    throw e
  }
}

// A lookup that reads the account listing at most once, however many usernames are
// asked for. The listing is a snapshot: fine for "was an EARLIER attempt's sub-user
// created", never for anything that must see a sub-user created seconds ago.
export function memoizedSubUserLookup(): SubUserLookup {
  let listing: Promise<{ subUsers: Map<string, SubUserSnapshot>; complete: boolean }> | null = null
  return async (username: string) => {
    listing ??= listAllSubUsers()
    const { subUsers, complete } = await listing
    for (const [id, snap] of subUsers) if (snap.username === username) return { id, complete: true }
    return { id: null, complete }
  }
}

// Raises an existing sub-user's traffic cap — used by the credential
// top-up flow so a customer can add GB to a credential they're already
// using instead of always minting a brand-new one.
//
// CRITICAL: this must NEVER send `activeUntil` in the same PATCH body.
// Per the live OpenAPI spec (PATCH /sub-users/{subUid}): "changing
// activeUntil resets sub-user current traffic usage." A top-up call that
// happened to also touch activeUntil would zero out trafficUsedMB on
// the provider's side — a free, repeatable usage-reset exploit disguised as a
// routine limit bump. Keep this function's request body to trafficLimitMB
// only, deliberately, rather than accepting a generic "patch fields"
// param that a future caller could accidentally widen.
export async function updateSubUserTrafficLimit(
  upstreamSubUserId: string,
  newTrafficLimitMB: number
): Promise<void> {
  const limitMb = Math.round(newTrafficLimitMB)
  if (!Number.isFinite(limitMb) || limitMb < 1) {
    throw new Error(`Refusing to set an invalid traffic limit (${newTrafficLimitMB} MB)`)
  }
  const res = await gfetch(
    `${BASE}/${RESELLER_ID}/services/${SERVICE_TYPE}/sub-users/${upstreamSubUserId}`,
    {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ trafficLimitMB: limitMb }),
    }
  )
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    // UpstreamApiError (not a bare Error) so callers can branch on status.
    throw new UpstreamApiError(`Upstream updateSubUserTrafficLimit failed: ${res.status} ${JSON.stringify(err)}`, res.status, err)
  }
}

// Replaces a sub-user's password (credential rotation). Same rule as the
// limit PATCH above: the body is exactly { password } — never activeUntil,
// which would reset the sub-user's traffic usage. Returns the password the
// provider echoes back (or null when it echoes nothing) so the caller can
// refuse to commit a rotation the provider silently ignored.
export async function updateSubUserPassword(
  upstreamSubUserId: string,
  newPassword: string
): Promise<string | null> {
  const res = await gfetch(
    `${BASE}/${RESELLER_ID}/services/${SERVICE_TYPE}/sub-users/${upstreamSubUserId}`,
    {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ password: newPassword }),
    }
  )
  const d = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new UpstreamApiError(`Upstream updateSubUserPassword failed: ${res.status} ${JSON.stringify(d)}`, res.status, d)
  }
  const result = d?.result ?? d?.data ?? d
  return typeof result?.password === 'string' ? result.password : null
}

// Maps a failed upstream call to a SUPPLIER-NEUTRAL reason. This is the only
// shape that may be persisted on a customer-readable row or shown in the UI:
// the raw error text names the supplier and can carry account identifiers.
//   capacity    — the pool can't cover the request (stock to be replenished)
//   unavailable — network/timeout/5xx: transient outage
//   error       — anything else (auth, validation, unknown)
export type UpstreamReason = 'capacity' | 'unavailable' | 'error'
export function classifyUpstreamError(e: unknown): UpstreamReason {
  if (e instanceof UpstreamApiError) {
    if (e.status >= 500 || e.status === 408 || e.status === 429) return 'unavailable'
    const msg = String(e.body?.message ?? e.body?.error ?? e.message ?? '').toLowerCase()
    // Not the bare words "traffic" / "bandwidth": the request field is trafficLimitMB, so a plain
    // validation error naming it used to read as "no capacity" and promised the customer
    // an activation that would never come.
    if (e.status === 402 || /insufficient|not enough|quota|capacity|out of stock|no stock|balance|(exceed\w*|more than)[^.]{0,40}(available|remaining|allocat|stock)|(available|remaining)[^.]{0,20}(traffic|bandwidth|balance|stock|mb)/.test(msg)) {
      return 'capacity'
    }
    return 'error'
  }
  const name = (e as any)?.name
  if (name === 'AbortError' || name === 'TypeError') return 'unavailable'
  return 'error'
}

// Per spec there is no separate "/usage" endpoint — usage comes back as
// trafficUsedMB on the same "get sub-user" call.
//
// IMPORTANT: this throws on a failed request rather than returning 0.
// It used to return 0 on `!res.ok`, which silently collapsed "Upstream
// errored / I don't actually know" into "confirmed zero usage" — and that
// fake zero fed straight into two money-affecting call sites:
//   1. syncUserUsage() (admin "sync this user now") would overwrite a
//      real, previously-synced gb_used with 0 on a transient Upstream
//      error, corrupting the exact number an admin is trying to fix.
//   2. The pre-delete live-usage check in dashboard/proxies/[id]/route.ts
//      would set liveUsedGb = 0 (not null) on a transient error — and
//      since `0 ?? cred.gb_used` evaluates to 0 (0 isn't nullish, so the
//      fallback to the last-synced value never fired), the full
//      gb_allocated got refunded regardless of real consumption. That's
//      the same delete-then-recreate revenue leak migration 0007/0009
//      already fixed once, reopened by any ordinary Upstream hiccup.
// Both call sites already have their own try/catch and correctly treat a
// thrown error as "unknown, don't touch the number" (skip in the sync
// loop; fall back to the last-synced gb_used on delete) — they just never
// got the chance to do that while this function swallowed the failure
// into a fake real value.
export async function getSubUserUsage(upstreamSubUserId: string): Promise<number> {
  const res = await gfetch(
    `${BASE}/${RESELLER_ID}/services/${SERVICE_TYPE}/sub-users/${upstreamSubUserId}`,
    { headers: headers() }
  )
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new UpstreamApiError(`Upstream getSubUserUsage failed: ${res.status} ${JSON.stringify(err)}`, res.status, err)
  }
  const d = await res.json()
  const result = d.result ?? d.data ?? d
  // A response without a numeric trafficUsedMB (schema change, partial
  // payload) must not read as "0 GB used" — that is the same fake zero this
  // function's header explains. Throw so every caller takes its existing
  // "unknown, leave the number alone" path.
  const usedMb = typeof result?.trafficUsedMB === 'number' ? result.trafficUsedMB : Number.NaN
  if (!Number.isFinite(usedMb) || usedMb < 0) {
    throw new Error('Upstream getSubUserUsage returned no usable trafficUsedMB')
  }
  return mbToGb(usedMb)
}

// Does this sub-user still exist upstream? true / false (404) — anything else THROWS, so
// "unknown" can never be mistaken for "gone" (admin re-provisioning acts on false).
export async function subUserExists(subUserId: string): Promise<boolean> {
  const res = await gfetch(
    `${BASE}/${RESELLER_ID}/services/${SERVICE_TYPE}/sub-users/${subUserId}`,
    { headers: headers() }
  )
  if (res.status === 404) return false
  if (res.ok) return true
  throw new UpstreamApiError(`Provider subUserExists failed: ${res.status}`, res.status, await res.json().catch(() => ({})))
}

// Bulk version — fetches usage for ALL sub-users in pages of 100 instead of
// one call per credential. Fixes a real production bug: the cron usage-sync
// job was making one Upstream API call per active credential in a loop,
// which crossed Cloudflare Workers' 50-subrequest-per-invocation cap (Free
// plan) once enough credentials existed from testing — the runtime enforces
// that cap below the level JS try/catch can intercept, so it killed the
// whole invocation with an opaque 500 regardless of per-credential error
// handling. This reduces N calls to ceil(N/100).
// Returns usage AND the live traffic limit AND the username per sub-user,
// plus a `complete` flag. It used to swallow a failed page and hand back
// whatever had been collected — indistinguishable from a full listing — so a
// Upstream outage or revoked key looked like a healthy sync and stamped the
// freshness marker the staleness watchdog depends on. Callers must check
// `complete` before treating absence from the map as meaningful.
export interface SubUserSnapshot {
  // null when Upstream didn't report a numeric usage figure for this sub-user.
  // Never coerced to 0: a missing figure must not overwrite real usage.
  usedGb: number | null
  usedMb: number | null
  limitMb: number | null // null when Upstream didn't report one
  username: string | null
}

// 40,000 sub-users. This IS a ceiling (reaching it reports the listing as incomplete, which
// stops usage sync from stamping freshness), so it is set far above any plausible fleet and
// reaching it is logged loudly. Each page is one subrequest — see usageSync for the budget.
const MAX_LIST_PAGES = 400

export async function listAllSubUsers(): Promise<{ subUsers: Map<string, SubUserSnapshot>; complete: boolean }> {
  const subUsers = new Map<string, SubUserSnapshot>()
  const limit = 100
  let offset = 0
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    let res: Response
    try {
      res = await gfetch(
        `${BASE}/${RESELLER_ID}/services/${SERVICE_TYPE}/sub-users?limit=${limit}&offset=${offset}`,
        { headers: headers() }
      )
    } catch (e) {
      console.error('Upstream listAllSubUsers request failed:', e)
      return { subUsers, complete: false }
    }
    if (!res.ok) {
      console.error('Upstream listAllSubUsers failed:', res.status, await res.text().catch(() => ''))
      return { subUsers, complete: false }
    }
    const d = await res.json().catch(() => null)
    if (!d) return { subUsers, complete: false }
    const result = d.result ?? d.data ?? d
    // A reply without a documents array is a changed/odd response shape, not an empty
    // account: calling it a complete empty listing would flag every live session as
    // missing upstream and stamp usage sync healthy.
    if (!Array.isArray(result?.documents)) {
      console.error('Upstream listAllSubUsers: unexpected response shape')
      return { subUsers, complete: false }
    }
    const docs = result.documents
    // The listing ends at an EMPTY page, not at "a page shorter than the
    // limit we asked for": if the provider ever caps its page size below 100
    // the old short-page rule declared a partial listing complete — stamping
    // the freshness marker, skipping usage for everything after page one and
    // reporting live sub-users as missing. One extra (cheap) call buys that
    // certainty. A provider-reported total, when present, short-circuits it.
    if (docs.length === 0) return { subUsers, complete: true }
    let added = 0
    for (const doc of docs) {
      const id = String(doc.id)
      if (!subUsers.has(id)) added++
      const usedMb = typeof doc.trafficUsedMB === 'number' && Number.isFinite(doc.trafficUsedMB) && doc.trafficUsedMB >= 0
        ? doc.trafficUsedMB
        : null
      const limitMb = doc.trafficLimitMB === undefined || doc.trafficLimitMB === null ? null : Number(doc.trafficLimitMB)
      subUsers.set(id, {
        usedGb: usedMb === null ? null : mbToGb(usedMb),
        usedMb,
        limitMb: limitMb !== null && Number.isFinite(limitMb) ? limitMb : null,
        username: typeof doc.username === 'string' ? doc.username : null,
      })
    }
    // A page of nothing but ids we already have means the provider is
    // ignoring `offset` — the listing is NOT complete and looping on it
    // would only burn subrequests.
    if (added === 0) {
      console.error('Upstream listAllSubUsers: page repeated already-seen sub-users — treating the listing as incomplete')
      return { subUsers, complete: false }
    }
    const total = Number(result.total ?? result.totalCount)
    if (docs.length < limit && Number.isFinite(total) && subUsers.size >= total) return { subUsers, complete: true }
    offset += docs.length
  }
  console.error(`Provider listAllSubUsers hit MAX_LIST_PAGES (${MAX_LIST_PAGES} pages) — treating the listing as incomplete. Usage sync cannot stamp freshness until this ceiling is raised or the listing is narrowed.`)
  return { subUsers, complete: false }
}

export async function getAccountBalance(): Promise<{ available_gb: number; total_gb: number }> {
  const res = await gfetch(
    `${BASE}/${RESELLER_ID}/services/${SERVICE_TYPE}/traffic`,
    { headers: headers() }
  )
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    console.error('Upstream getAccountBalance failed:', res.status, errText)
    throw new Error(`Upstream getAccountBalance failed: ${res.status} ${errText}`)
  }
  const d = await res.json()
  const result = d.result ?? d.data ?? d
  // remainingMB (= totalMB - usedMB) tracks only the reseller's own direct
  // traffic — it does NOT subtract allocatedToSubUsersMB, so it silently
  // overstates real sellable stock by however much is already committed to
  // customer credentials but not yet consumed. availableForAllocationMB
  // (= totalMB - allocatedToSubUsersMB) is the field that actually answers
  // "how much can I still sell" — confirmed against the live OpenAPI spec's
  // /traffic response schema. This is what the provider's own dashboard shows
  // as "Available Bandwidth", and what our stock/exposure alerting needs
  // to match — using remainingMB here is what caused the admin panel to
  // read higher than the provider's true available figure.
  // A response without numeric figures (schema change, partial payload) must not read
  // as "0 GB in stock": that raised a false exposure alert. Throw, like getSubUserUsage.
  const avail = result?.availableForAllocationMB
  const total = result?.totalMB
  if (typeof avail !== 'number' || !Number.isFinite(avail) || typeof total !== 'number' || !Number.isFinite(total)) {
    throw new Error('Provider getAccountBalance returned no usable traffic figures')
  }
  return { available_gb: mbToGb(avail), total_gb: mbToGb(total) }
}

// IMPORTANT: the live OpenAPI spec for this API has no purchase/reload
// endpoint at all — only Traffic (read), Sub-users (CRUD), Whitelisted IPs,
// and Usage Statistics. This function is now disabled rather than calling a
// made-up URL. Reloading reseller stock may require the provider's dashboard/
// billing directly rather than the API — confirm with Upstream support before
// re-enabling this, and update the real endpoint here once known.
export async function purchaseBandwidth(gb: number): Promise<void> {
  throw new Error(
    'Upstream reseller API has no documented purchase/reload endpoint. ' +
    'This call has been disabled rather than hitting a nonexistent URL — ' +
    'confirm the correct mechanism with Upstream support before re-enabling.'
  )
}

// Thrown by every function below instead of a plain Error, so callers
// (the API routes) can branch on the real Upstream HTTP status instead of
// regex-parsing a formatted message string. The other functions in this
// file predate this and were left as-is rather than widening their
// existing (already-handled-at-each-callsite) contracts.
export class UpstreamApiError extends Error {
  status: number
  body: any
  constructor(message: string, status: number, body: any) {
    super(message)
    this.name = 'UpstreamApiError'
    this.status = status
    this.body = body
  }
}

export interface WhitelistedIp {
  ip: string
  description: string
}

// ─── Usage Statistics (separate monitor host) ─────────────────────────────
// Confirmed against the live OpenAPI spec: these two endpoints live on a
// DIFFERENT host (the monitor host, not the reseller API host) and use a
// DIFFERENT auth header — "r-api-key", not "Reseller-Api-Key". Also unlike
// every other call in this file, the path has no {resellerUid} segment —
// the API key alone scopes the request to this reseller's account. Mixing
// these up (reseller header on the monitor host, or vice versa) reads as
// an auth failure with no hint that it's actually the wrong host/header
// pair, so keep this section's requests fully separate from headers()/BASE
// above rather than trying to generalize them together.
const MONITOR_BASE = 'https://monitor.geonode.com'

function monitorHeaders() {
  return {
    'r-api-key': KEY,
    'Content-Type': 'application/json',
  }
}

// Per the spec: dateFrom/dateTo together with granularity may not span
// more than 720 units (minutes/hours/days). Callers are expected to stay
// well under that (this app only ever asks for 7 or 30 days at
// granularity=day), but this is a hard ceiling on the provider side, not
// just a suggestion — a caller that ignores it gets a 400 from Upstream,
// not a silently truncated range.
export const MAX_STATS_GRANULARITY_UNITS = 720

export interface PeriodStat {
  periodStart: string
  bandwidthBytes: number
  failedRequests: number
  successfulRequests: number
  successRate: number
  totalRequests: number
}

// Time-series usage for a single sub-user (by Upstream username, NOT the
// numeric upstream_sub_user_id — confirmed from the spec's own example
// values, and matches what subUserId comes back as in
// per-subuser-host-country below). Always grouped by periodStart; there is
// no per-subuser breakdown on this endpoint, which is why the usage-history
// route calls this once per credential and merges by date rather than
// asking for ".all" and trying to split it back out afterward.
export async function getPeriodStats(
  subUserFilter: string,
  dateFrom: Date,
  dateTo: Date,
  granularity: 'minute' | 'hour' | 'day' = 'day'
): Promise<PeriodStat[]> {
  const params = new URLSearchParams({
    granularity,
    dateFrom: dateFrom.toISOString(),
    dateTo: dateTo.toISOString(),
    subUserFilter,
  })
  const res = await gfetch(
    `${MONITOR_BASE}/statistics/${SERVICE_TYPE}/per-period?${params}`,
    { headers: monitorHeaders() }
  )
  const d = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new UpstreamApiError(
      d?.message || `Upstream getPeriodStats failed: ${res.status}`,
      res.status,
      d
    )
  }
  return d.documents ?? []
}

export interface HostCountryStat {
  subUserId: string
  email: string
  host: string
  country: string
  bandwidthBytes: number
  avgLatency: number
  avgDuration: number
  failedRequests: number
  successfulRequests: number
  successRate: number
  totalRequests: number
}

// Breakdown of usage by destination host + target country for a single
// sub-user, paginated (max 5000/page per spec). This is what actually
// answers "what is this credential being used to scrape, and where" —
// the per-period endpoint above only ever returns a single aggregated
// bandwidth number per date, with no host/country dimension at all.
//
// hardCap bounds total pages fetched (not just per-page size) so a
// pathological result set can't turn one usage-history page load into an
// unbounded number of upstream calls — same subrequest-budget concern
// documented on listAllSubUsersUsage above, just scoped to a single
// credential's stats instead of the full-account usage-sync cron.
export async function getHostCountryStatsWithMeta(
  subUserFilter: string,
  dateFrom: Date,
  dateTo: Date,
  granularity: 'minute' | 'hour' | 'day' = 'day',
  limit = 500,
  hardCap = 2000
): Promise<{ stats: HostCountryStat[]; truncated: boolean }> {
  const results: HostCountryStat[] = []
  // The page size actually sent to Upstream (max 5000 per spec). The "was that
  // the last page" check must compare against THIS, not the caller's raw
  // `limit` — with limit > 5000 the old check never saw a short page and
  // looped to the hard cap.
  const pageSize = Math.max(1, Math.min(limit, 5000))
  let offset = 0
  let truncated = false
  while (true) {
    if (results.length >= hardCap) {
      // The cap was reached exactly on a full page: only report truncation if a
      // row really exists beyond it (one tiny probe), not merely because the
      // last page happened to be full.
      const probe = new URLSearchParams({
        granularity, dateFrom: dateFrom.toISOString(), dateTo: dateTo.toISOString(),
        subUserFilter, limit: '1', offset: String(offset),
      })
      const pr = await gfetch(`${MONITOR_BASE}/statistics/${SERVICE_TYPE}/per-subuser-host-country?${probe}`, { headers: monitorHeaders() })
      const pd = await pr.json().catch(() => ({}))
      truncated = pr.ok ? (pd.documents ?? []).length > 0 : true
      break
    }
    const params = new URLSearchParams({
      granularity,
      dateFrom: dateFrom.toISOString(),
      dateTo: dateTo.toISOString(),
      subUserFilter,
      limit: String(pageSize),
      offset: String(offset),
    })
    const res = await gfetch(
      `${MONITOR_BASE}/statistics/${SERVICE_TYPE}/per-subuser-host-country?${params}`,
      { headers: monitorHeaders() }
    )
    const d = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new UpstreamApiError(
        d?.message || `Upstream getHostCountryStats failed: ${res.status}`,
        res.status,
        d
      )
    }
    const docs: HostCountryStat[] = d.documents ?? []
    results.push(...docs)
    if (docs.length < pageSize) break // last page
    offset += pageSize
  }
  return { stats: results.slice(0, hardCap), truncated }
}

export async function getHostCountryStats(
  subUserFilter: string,
  dateFrom: Date,
  dateTo: Date,
  granularity: 'minute' | 'hour' | 'day' = 'day',
  limit = 500,
  hardCap = 2000
): Promise<HostCountryStat[]> {
  return (await getHostCountryStatsWithMeta(subUserFilter, dateFrom, dateTo, granularity, limit, hardCap)).stats
}

// ─── Whitelisted IPs ──────────────────────────────────────────────────────
// Confirmed against the live OpenAPI spec: GET/POST .../whitelisted-ips,
// POST .../whitelisted-ips/bulk-create, POST .../whitelisted-ips/bulk-delete,
// DELETE .../whitelisted-ips/{ip} — all scoped under the same
// resellerUid/serviceType/sub-users/{subUid} path every other sub-user call
// in this file uses. This restricts which source IPs may authenticate with
// a given sub-user's credentials, layered on top of the username/password
// pair which is currently the only access control a credential has.
//
// Every one of these endpoints returns the sub-user's full, current
// whitelist as `result` (even DELETE) — so callers can just replace their
// local list with the response rather than re-fetching separately.

async function whitelistRequest(
  upstreamSubUserId: string,
  path: string,
  init?: RequestInit
): Promise<WhitelistedIp[]> {
  const res = await gfetch(
    `${BASE}/${RESELLER_ID}/services/${SERVICE_TYPE}/sub-users/${upstreamSubUserId}/whitelisted-ips${path}`,
    { ...init, headers: headers() }
  )
  const d = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new UpstreamApiError(
      d?.message || `Upstream whitelist request failed: ${res.status}`,
      res.status,
      d
    )
  }
  const result = d.result ?? d.data ?? d
  // Projected to exactly what customers are meant to see. The provider's entries
  // were passed through untouched, so any extra field it returns (its own ids,
  // account or sub-user identifiers) went straight into customer API responses.
  return Array.isArray(result)
    ? result
        .filter((x: any) => x && typeof x.ip === 'string')
        .map((x: any): WhitelistedIp => ({ ip: x.ip, description: typeof x.description === 'string' ? x.description : '' }))
    : []
}

export function listWhitelistedIps(upstreamSubUserId: string): Promise<WhitelistedIp[]> {
  return whitelistRequest(upstreamSubUserId, '', { method: 'GET' })
}

export function addWhitelistedIp(
  upstreamSubUserId: string,
  ip: string,
  description: string
): Promise<WhitelistedIp[]> {
  return whitelistRequest(upstreamSubUserId, '', {
    method: 'POST',
    body: JSON.stringify({ ip, description }),
  })
}

// Max 150 items per request (matches the spec's maxItems on `items`).
// Upstream dedupes by IP within the request (first description wins) and
// skips IPs already on the whitelist.
export function bulkAddWhitelistedIps(
  upstreamSubUserId: string,
  items: WhitelistedIp[]
): Promise<WhitelistedIp[]> {
  return whitelistRequest(upstreamSubUserId, '/bulk-create', {
    method: 'POST',
    body: JSON.stringify({ items }),
  })
}

export function removeWhitelistedIp(
  upstreamSubUserId: string,
  ip: string
): Promise<WhitelistedIp[]> {
  // The IP is a path segment here (DELETE /whitelisted-ips/{ip}), not a
  // query param or body field — encode it so a literal IPv6 address
  // (colons) doesn't get misparsed as part of the URL structure.
  return whitelistRequest(upstreamSubUserId, `/${encodeURIComponent(ip)}`, {
    method: 'DELETE',
  })
}

// Unknown IPs are ignored by Upstream; an empty list is a no-op. Max 150
// per request (matches the spec's maxItems on `ips`).
export function bulkRemoveWhitelistedIps(
  upstreamSubUserId: string,
  ips: string[]
): Promise<WhitelistedIp[]> {
  return whitelistRequest(upstreamSubUserId, '/bulk-delete', {
    method: 'POST',
    body: JSON.stringify({ ips }),
  })
}

export async function deleteSubUser(upstreamSubUserId: string): Promise<void> {
  const res = await gfetch(`${BASE}/${RESELLER_ID}/services/${SERVICE_TYPE}/sub-users/${upstreamSubUserId}`, {
    method: 'DELETE',
    headers: headers(),
  })
  if (!res.ok) {
    // Previously this was fire-and-forget with no status check, so every
    // caller's `.catch(...)` around a "cleanup" deleteSubUser call never
    // fired on failure — a failed delete looked identical to a successful
    // one, leaving orphaned sub-users on the provider's side with no local
    // record and no way to find them again.
    const err = await res.json().catch(() => ({}))
    // UpstreamApiError (not a bare Error) so callers can tell "already gone"
    // (404 — safe to treat as deleted) from a real failure.
    throw new UpstreamApiError(`Upstream deleteSubUser failed: ${res.status} ${JSON.stringify(err)}`, res.status, err)
  }
}

// ─── Debug only — admin diagnostic endpoint ──────────────────────────────────
// Creates a 10 MB test sub-user, captures the full raw Upstream response,
// then immediately deletes it. Used by /api/admin/debug-upstream to verify:
//   1. API key and reseller ID are valid
//   2. Exact field names Upstream returns
//   3. trafficLimitMB is the correct request field name
export async function debugCreateSubUser(): Promise<{
  raw_request: object
  raw_response: object | null
  http_status: number | null
  parsed_gcred: GCred | null
  // false means the provider rewrote the username we asked for (a prefix, say):
  // customers would then see that rewritten name and the orphan sweep (gp_
  // prefix) would not recognise these sub-users. Check this on first deploy.
  username_matches_requested: boolean | null
  cleanup_deleted: boolean
  error: string | null
}> {
  const username = `gp_debug_${Date.now()}`
  const password = genPassword()

  const requestBody = {
    username,
    password,
    trafficLimitMB: 10, // 10 MB — smallest testable amount
  }

  let httpStatus: number | null = null
  let rawResponse: object | null = null
  let parsedGcred: GCred | null = null
  let cleanupDeleted = false
  let error: string | null = null
  let usernameMatches: boolean | null = null

  try {
    const res = await gfetch(`${BASE}/${RESELLER_ID}/services/${SERVICE_TYPE}/sub-users`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(requestBody),
    })
    httpStatus = res.status
    const text = await res.text()
    try { rawResponse = JSON.parse(text) } catch { rawResponse = { raw_text: text } }

    if (res.ok && rawResponse) {
      const d = rawResponse as any
      const result = d.result ?? d.data ?? d
      parsedGcred = {
        upstream_sub_user_id: String(result.id ?? username),
        username: result.username ?? username,
        password: result.password ?? password,
        host: PROXY_HOST,
        port: getProxyPort('http', 'rotating'),
        protocol: 'http',
      }
      usernameMatches = parsedGcred.username === username

      // Immediately clean up — don't leave test sub-users in Upstream
      try {
        const delRes = await gfetch(
          `${BASE}/${RESELLER_ID}/services/${SERVICE_TYPE}/sub-users/${parsedGcred.upstream_sub_user_id}`,
          { method: 'DELETE', headers: headers() }
        )
        cleanupDeleted = delRes.ok
      } catch {
        cleanupDeleted = false
      }
    } else {
      error = `HTTP ${httpStatus} — see raw_response`
    }
  } catch (e: any) {
    error = e.message
  }

  return {
    raw_request: requestBody,
    raw_response: rawResponse,
    http_status: httpStatus,
    parsed_gcred: parsedGcred,
    username_matches_requested: usernameMatches,
    cleanup_deleted: cleanupDeleted,
    error,
  }
}
