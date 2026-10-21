import { getProxyPort } from '@/lib/proxyEndpoint'

const BASE = 'https://app-api.geonode.com/api/reseller/v2'
const KEY = process.env.GEONODE_API_KEY!
const RESELLER_ID = process.env.GEONODE_RESELLER_ID!
const SERVICE_TYPE = 'RESIDENTIAL-PREMIUM'

// White-label host — always expose this to users, never residential.geonode.com
export const PROXY_HOST = 'proxy.globproxy.com'

// Confirmed against the live OpenAPI spec (app-api.geonode.com/api/docs/reseller-api):
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

// Every Geonode call goes through this. Without a timeout a hung upstream
// holds the Worker open until the platform kills it — and createCredential
// has a bandwidth reservation committed by then (a kill between the reserve
// and the insert leaks it permanently).
const REQUEST_TIMEOUT_MS = 12_000
async function gfetchOnce(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
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
  // NOTE: Geonode's sub-user creation endpoint does not accept country, state,
  // city, protocol, or session_type — confirmed from the live spec, which only
  // takes username/password/trafficLimitMB/activeUntil/email. Geonode applies
  // geo-targeting and session control by suffixing options onto the username
  // at connection time (e.g. "user-country-us-session-abc123"), not at
  // creation time. These fields are accepted here so calling code doesn't
  // need to change yet, but they are currently NOT sent to Geonode and NOT
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

export async function createSubUser(p: CreateSubUserParams): Promise<GCred> {
  // Date.now() alone is millisecond-resolution — bulk activation paths
  // (activateBandwidth looping over several pending credentials/transfers,
  // or a burst of API calls) can generate this within the same millisecond
  // and collide. Adding a few random hex bytes keeps it unique under load.
  const username = `gp_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`
  const password = genPassword()
  // Previously: p.protocol === 'socks5' ? 7000 : 9000 — wrong on two counts.
  // SOCKS5 isn't 7000 (unverified guess), and neither number accounted for
  // sticky vs rotating at all. See lib/proxyEndpoint.ts for the confirmed values.
  const port = getProxyPort(p.protocol, p.session_type)

  // A limit that rounds to 0 MB must never reach Geonode: depending on the
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
    throw new Error(`Geonode createSubUser failed: ${res.status} ${JSON.stringify(err)}`)
  }

  const d = await res.json()
  const result = d.result ?? d.data ?? d

  // Previously fell back to the username when Geonode returned no id. Every
  // later PATCH/DELETE/usage call is keyed on the numeric id, so a username
  // there silently 404s forever. Fail loudly instead; the orphan sweep in
  // usage sync surfaces the sub-user that was created.
  if (result?.id === undefined || result?.id === null || result?.id === '') {
    console.error('Geonode createSubUser returned no id for', username, JSON.stringify(d))
    throw new Error('Geonode createSubUser returned no sub-user id')
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

// Raises an existing sub-user's traffic cap — used by the credential
// top-up flow so a customer can add GB to a credential they're already
// using instead of always minting a brand-new one.
//
// CRITICAL: this must NEVER send `activeUntil` in the same PATCH body.
// Per the live OpenAPI spec (PATCH /sub-users/{subUid}): "changing
// activeUntil resets sub-user current traffic usage." A top-up call that
// happened to also touch activeUntil would zero out trafficUsedMB on
// Geonode's side — a free, repeatable usage-reset exploit disguised as a
// routine limit bump. Keep this function's request body to trafficLimitMB
// only, deliberately, rather than accepting a generic "patch fields"
// param that a future caller could accidentally widen.
export async function updateSubUserTrafficLimit(
  geonodeSubUserId: string,
  newTrafficLimitMB: number
): Promise<void> {
  const limitMb = Math.round(newTrafficLimitMB)
  if (!Number.isFinite(limitMb) || limitMb < 1) {
    throw new Error(`Refusing to set an invalid traffic limit (${newTrafficLimitMB} MB)`)
  }
  const res = await gfetch(
    `${BASE}/${RESELLER_ID}/services/${SERVICE_TYPE}/sub-users/${geonodeSubUserId}`,
    {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ trafficLimitMB: limitMb }),
    }
  )
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    // GeonodeApiError (not a bare Error) so callers can branch on status.
    throw new GeonodeApiError(`Geonode updateSubUserTrafficLimit failed: ${res.status} ${JSON.stringify(err)}`, res.status, err)
  }
}

// Per spec there is no separate "/usage" endpoint — usage comes back as
// trafficUsedMB on the same "get sub-user" call.
//
// IMPORTANT: this throws on a failed request rather than returning 0.
// It used to return 0 on `!res.ok`, which silently collapsed "Geonode
// errored / I don't actually know" into "confirmed zero usage" — and that
// fake zero fed straight into two money-affecting call sites:
//   1. syncUserUsage() (admin "sync this user now") would overwrite a
//      real, previously-synced gb_used with 0 on a transient Geonode
//      error, corrupting the exact number an admin is trying to fix.
//   2. The pre-delete live-usage check in dashboard/proxies/[id]/route.ts
//      would set liveUsedGb = 0 (not null) on a transient error — and
//      since `0 ?? cred.gb_used` evaluates to 0 (0 isn't nullish, so the
//      fallback to the last-synced value never fired), the full
//      gb_allocated got refunded regardless of real consumption. That's
//      the same delete-then-recreate revenue leak migration 0007/0009
//      already fixed once, reopened by any ordinary Geonode hiccup.
// Both call sites already have their own try/catch and correctly treat a
// thrown error as "unknown, don't touch the number" (skip in the sync
// loop; fall back to the last-synced gb_used on delete) — they just never
// got the chance to do that while this function swallowed the failure
// into a fake real value.
export async function getSubUserUsage(geonodeSubUserId: string): Promise<number> {
  const res = await gfetch(
    `${BASE}/${RESELLER_ID}/services/${SERVICE_TYPE}/sub-users/${geonodeSubUserId}`,
    { headers: headers() }
  )
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Geonode getSubUserUsage failed: ${res.status} ${JSON.stringify(err)}`)
  }
  const d = await res.json()
  const result = d.result ?? d.data ?? d
  return mbToGb(result.trafficUsedMB ?? 0)
}

// Bulk version — fetches usage for ALL sub-users in pages of 100 instead of
// one call per credential. Fixes a real production bug: the cron usage-sync
// job was making one Geonode API call per active credential in a loop,
// which crossed Cloudflare Workers' 50-subrequest-per-invocation cap (Free
// plan) once enough credentials existed from testing — the runtime enforces
// that cap below the level JS try/catch can intercept, so it killed the
// whole invocation with an opaque 500 regardless of per-credential error
// handling. This reduces N calls to ceil(N/100).
// Returns usage AND the live traffic limit AND the username per sub-user,
// plus a `complete` flag. It used to swallow a failed page and hand back
// whatever had been collected — indistinguishable from a full listing — so a
// Geonode outage or revoked key looked like a healthy sync and stamped the
// freshness marker the staleness watchdog depends on. Callers must check
// `complete` before treating absence from the map as meaningful.
export interface SubUserSnapshot {
  usedGb: number
  usedMb: number
  limitMb: number | null // null when Geonode didn't report one
  username: string | null
}

const MAX_LIST_PAGES = 100 // 10,000 sub-users — a runaway guard, not a real ceiling

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
      console.error('Geonode listAllSubUsers request failed:', e)
      return { subUsers, complete: false }
    }
    if (!res.ok) {
      console.error('Geonode listAllSubUsers failed:', res.status, await res.text().catch(() => ''))
      return { subUsers, complete: false }
    }
    const d = await res.json().catch(() => null)
    if (!d) return { subUsers, complete: false }
    const result = d.result ?? d.data ?? d
    const docs = result.documents ?? []
    for (const doc of docs) {
      const usedMb = Number(doc.trafficUsedMB ?? 0)
      const limitMb = doc.trafficLimitMB === undefined || doc.trafficLimitMB === null ? null : Number(doc.trafficLimitMB)
      subUsers.set(String(doc.id), {
        usedGb: mbToGb(usedMb),
        usedMb,
        limitMb: limitMb !== null && Number.isFinite(limitMb) ? limitMb : null,
        username: typeof doc.username === 'string' ? doc.username : null,
      })
    }
    if (docs.length < limit) return { subUsers, complete: true } // last page
    offset += limit
  }
  console.error('Geonode listAllSubUsers hit MAX_LIST_PAGES — treating the listing as incomplete')
  return { subUsers, complete: false }
}

export async function getAccountBalance(): Promise<{ available_gb: number; total_gb: number }> {
  const res = await gfetch(
    `${BASE}/${RESELLER_ID}/services/${SERVICE_TYPE}/traffic`,
    { headers: headers() }
  )
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    console.error('Geonode getAccountBalance failed:', res.status, errText)
    throw new Error(`Geonode getAccountBalance failed: ${res.status} ${errText}`)
  }
  const d = await res.json()
  const result = d.result ?? d.data ?? d
  // remainingMB (= totalMB - usedMB) tracks only the reseller's own direct
  // traffic — it does NOT subtract allocatedToSubUsersMB, so it silently
  // overstates real sellable stock by however much is already committed to
  // customer credentials but not yet consumed. availableForAllocationMB
  // (= totalMB - allocatedToSubUsersMB) is the field that actually answers
  // "how much can I still sell" — confirmed against the live OpenAPI spec's
  // /traffic response schema. This is what Geonode's own dashboard shows
  // as "Available Bandwidth", and what our stock/exposure alerting needs
  // to match — using remainingMB here is what caused the admin panel to
  // read higher than Geonode's true available figure.
  return {
    available_gb: mbToGb(result.availableForAllocationMB ?? 0),
    total_gb: mbToGb(result.totalMB ?? 0),
  }
}

// IMPORTANT: the live OpenAPI spec for this API has no purchase/reload
// endpoint at all — only Traffic (read), Sub-users (CRUD), Whitelisted IPs,
// and Usage Statistics. This function is now disabled rather than calling a
// made-up URL. Reloading reseller stock may require Geonode's dashboard/
// billing directly rather than the API — confirm with Geonode support before
// re-enabling this, and update the real endpoint here once known.
export async function purchaseBandwidth(gb: number): Promise<void> {
  throw new Error(
    'Geonode reseller API has no documented purchase/reload endpoint. ' +
    'This call has been disabled rather than hitting a nonexistent URL — ' +
    'confirm the correct mechanism with Geonode support before re-enabling.'
  )
}

// Thrown by every function below instead of a plain Error, so callers
// (the API routes) can branch on the real Geonode HTTP status instead of
// regex-parsing a formatted message string. The other functions in this
// file predate this and were left as-is rather than widening their
// existing (already-handled-at-each-callsite) contracts.
export class GeonodeApiError extends Error {
  status: number
  body: any
  constructor(message: string, status: number, body: any) {
    super(message)
    this.name = 'GeonodeApiError'
    this.status = status
    this.body = body
  }
}

export interface WhitelistedIp {
  ip: string
  description: string
}

// ─── Usage Statistics (monitor.geonode.com) ──────────────────────────────
// Confirmed against the live OpenAPI spec: these two endpoints live on a
// DIFFERENT host (monitor.geonode.com, not app-api.geonode.com) and use a
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
// just a suggestion — a caller that ignores it gets a 400 from Geonode,
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

// Time-series usage for a single sub-user (by Geonode username, NOT the
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
    throw new GeonodeApiError(
      d?.message || `Geonode getPeriodStats failed: ${res.status}`,
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
  // The page size actually sent to Geonode (max 5000 per spec). The "was that
  // the last page" check must compare against THIS, not the caller's raw
  // `limit` — with limit > 5000 the old check never saw a short page and
  // looped to the hard cap.
  const pageSize = Math.max(1, Math.min(limit, 5000))
  let offset = 0
  let truncated = false
  while (true) {
    if (results.length >= hardCap) { truncated = true; break }
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
      throw new GeonodeApiError(
        d?.message || `Geonode getHostCountryStats failed: ${res.status}`,
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
  geonodeSubUserId: string,
  path: string,
  init?: RequestInit
): Promise<WhitelistedIp[]> {
  const res = await gfetch(
    `${BASE}/${RESELLER_ID}/services/${SERVICE_TYPE}/sub-users/${geonodeSubUserId}/whitelisted-ips${path}`,
    { ...init, headers: headers() }
  )
  const d = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new GeonodeApiError(
      d?.message || `Geonode whitelist request failed: ${res.status}`,
      res.status,
      d
    )
  }
  const result = d.result ?? d.data ?? d
  return Array.isArray(result) ? result : []
}

export function listWhitelistedIps(geonodeSubUserId: string): Promise<WhitelistedIp[]> {
  return whitelistRequest(geonodeSubUserId, '', { method: 'GET' })
}

export function addWhitelistedIp(
  geonodeSubUserId: string,
  ip: string,
  description: string
): Promise<WhitelistedIp[]> {
  return whitelistRequest(geonodeSubUserId, '', {
    method: 'POST',
    body: JSON.stringify({ ip, description }),
  })
}

// Max 150 items per request (matches the spec's maxItems on `items`).
// Geonode dedupes by IP within the request (first description wins) and
// skips IPs already on the whitelist.
export function bulkAddWhitelistedIps(
  geonodeSubUserId: string,
  items: WhitelistedIp[]
): Promise<WhitelistedIp[]> {
  return whitelistRequest(geonodeSubUserId, '/bulk-create', {
    method: 'POST',
    body: JSON.stringify({ items }),
  })
}

export function removeWhitelistedIp(
  geonodeSubUserId: string,
  ip: string
): Promise<WhitelistedIp[]> {
  // The IP is a path segment here (DELETE /whitelisted-ips/{ip}), not a
  // query param or body field — encode it so a literal IPv6 address
  // (colons) doesn't get misparsed as part of the URL structure.
  return whitelistRequest(geonodeSubUserId, `/${encodeURIComponent(ip)}`, {
    method: 'DELETE',
  })
}

// Unknown IPs are ignored by Geonode; an empty list is a no-op. Max 150
// per request (matches the spec's maxItems on `ips`).
export function bulkRemoveWhitelistedIps(
  geonodeSubUserId: string,
  ips: string[]
): Promise<WhitelistedIp[]> {
  return whitelistRequest(geonodeSubUserId, '/bulk-delete', {
    method: 'POST',
    body: JSON.stringify({ ips }),
  })
}

export async function deleteSubUser(geonodeSubUserId: string): Promise<void> {
  const res = await gfetch(`${BASE}/${RESELLER_ID}/services/${SERVICE_TYPE}/sub-users/${geonodeSubUserId}`, {
    method: 'DELETE',
    headers: headers(),
  })
  if (!res.ok) {
    // Previously this was fire-and-forget with no status check, so every
    // caller's `.catch(...)` around a "cleanup" deleteSubUser call never
    // fired on failure — a failed delete looked identical to a successful
    // one, leaving orphaned sub-users on Geonode's side with no local
    // record and no way to find them again.
    const err = await res.json().catch(() => ({}))
    // GeonodeApiError (not a bare Error) so callers can tell "already gone"
    // (404 — safe to treat as deleted) from a real failure.
    throw new GeonodeApiError(`Geonode deleteSubUser failed: ${res.status} ${JSON.stringify(err)}`, res.status, err)
  }
}

// ─── Debug only — admin diagnostic endpoint ──────────────────────────────────
// Creates a 10 MB test sub-user, captures the full raw Geonode response,
// then immediately deletes it. Used by /api/admin/debug-geonode to verify:
//   1. API key and reseller ID are valid
//   2. Exact field names Geonode returns
//   3. trafficLimitMB is the correct request field name
export async function debugCreateSubUser(): Promise<{
  raw_request: object
  raw_response: object | null
  http_status: number | null
  parsed_gcred: GCred | null
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

      // Immediately clean up — don't leave test sub-users in Geonode
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
    cleanup_deleted: cleanupDeleted,
    error,
  }
}
