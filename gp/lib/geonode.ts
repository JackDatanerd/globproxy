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

function mbToGb(mb: number): number {
  return Math.round((mb / 1024) * 100) / 100
}

// Spec requires password to be uuid-formatted, not an arbitrary string —
// the previous genPassword() (16 random chars) would 400 once auth worked.
function genPassword(): string {
  return crypto.randomUUID()
}

export interface GCred {
  geonode_sub_user_id: string
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

  const res = await fetch(`${BASE}/${RESELLER_ID}/services/${SERVICE_TYPE}/sub-users`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      username,
      password,
      trafficLimitMB: Math.round(p.gb_limit * 1024),
      // activeUntil / email omitted — both optional per spec
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Geonode createSubUser failed: ${res.status} ${JSON.stringify(err)}`)
  }

  const d = await res.json()
  const result = d.result ?? d.data ?? d

  return {
    geonode_sub_user_id: String(result.id ?? username),
    username: result.username ?? username,
    password: result.password ?? password,
    host: PROXY_HOST,
    port,
    protocol: p.protocol ?? 'http',
  }
}

// Per spec there is no separate "/usage" endpoint — usage comes back as
// trafficUsedMB on the same "get sub-user" call.
export async function getSubUserUsage(geonodeSubUserId: string): Promise<number> {
  const res = await fetch(
    `${BASE}/${RESELLER_ID}/services/${SERVICE_TYPE}/sub-users/${geonodeSubUserId}`,
    { headers: headers() }
  )
  if (!res.ok) return 0
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
export async function listAllSubUsersUsage(): Promise<Map<string, number>> {
  const usageMap = new Map<string, number>()
  let offset = 0
  const limit = 100
  while (true) {
    const res = await fetch(
      `${BASE}/${RESELLER_ID}/services/${SERVICE_TYPE}/sub-users?limit=${limit}&offset=${offset}`,
      { headers: headers() }
    )
    if (!res.ok) {
      console.error('Geonode listAllSubUsersUsage failed:', res.status, await res.text().catch(() => ''))
      break // return whatever was collected so far rather than throwing
    }
    const d = await res.json()
    const result = d.result ?? d.data ?? d
    const docs = result.documents ?? []
    for (const doc of docs) {
      usageMap.set(String(doc.id), mbToGb(doc.trafficUsedMB ?? 0))
    }
    if (docs.length < limit) break // last page
    offset += limit
  }
  return usageMap
}

export async function getAccountBalance(): Promise<{ available_gb: number; total_gb: number }> {
  const res = await fetch(
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
  return {
    available_gb: mbToGb(result.remainingMB ?? 0),
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

export async function deleteSubUser(geonodeSubUserId: string): Promise<void> {
  const res = await fetch(`${BASE}/${RESELLER_ID}/services/${SERVICE_TYPE}/sub-users/${geonodeSubUserId}`, {
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
    throw new Error(`Geonode deleteSubUser failed: ${res.status} ${JSON.stringify(err)}`)
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
    const res = await fetch(`${BASE}/${RESELLER_ID}/services/${SERVICE_TYPE}/sub-users`, {
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
        geonode_sub_user_id: String(result.id ?? username),
        username: result.username ?? username,
        password: result.password ?? password,
        host: PROXY_HOST,
        port: 9000,
        protocol: 'http',
      }

      // Immediately clean up — don't leave test sub-users in Geonode
      try {
        const delRes = await fetch(
          `${BASE}/${RESELLER_ID}/services/${SERVICE_TYPE}/sub-users/${parsedGcred.geonode_sub_user_id}`,
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
