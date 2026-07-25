const BASE = 'https://app-api.geonode.com/api/reseller/v2'
const KEY = process.env.GEONODE_API_KEY!
const RESELLER_ID = process.env.GEONODE_RESELLER_ID!
const SERVICE_TYPE = 'RESIDENTIAL-PREMIUM'

// White-label host — always expose this to users, never residential.geonode.com
export const PROXY_HOST = 'proxy.globproxy.com'

function headers() {
  // Confirmed via live 401 "Authorization is not provided" — the reseller
  // API wants a standard Authorization header, not r-api-key. GEONODE_API_AUTH
  // holds the scheme ("Bearer") and was sitting unused in .env.local before this.
  const scheme = process.env.GEONODE_API_AUTH || 'Bearer'
  return {
    'Authorization': `${scheme} ${KEY}`,
    'Content-Type': 'application/json',
  }
}

function mbToGb(mb: number): number {
  return Math.round((mb / 1024) * 100) / 100
}

function genPassword(): string {
  const c = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  return Array.from({ length: 16 }, () => c[Math.floor(Math.random() * c.length)]).join('')
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
  country?: string
  state?: string
  city?: string
  protocol?: 'http' | 'socks5'
  session_type?: 'rotating' | 'sticky'
  sticky_duration?: number // minutes
}

export async function createSubUser(p: CreateSubUserParams): Promise<GCred> {
  const username = `gp_${Date.now()}`
  const password = genPassword()
  const port = p.protocol === 'socks5' ? 7000 : 9000

  const res = await fetch(`${BASE}/${RESELLER_ID}/sub-users`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      username,
      password,
      bandwidth_limit_mb: Math.round(p.gb_limit * 1024),
      country: p.country ?? null,
      state: p.state ?? null,
      city: p.city ?? null,
      protocol: p.protocol ?? 'http',
      session_type: p.session_type ?? 'rotating',
      ...(p.sticky_duration ? { sticky_duration: p.sticky_duration * 60 } : {}),
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Geonode createSubUser failed: ${res.status} ${JSON.stringify(err)}`)
  }

  const d = await res.json()
  const result = d.data ?? d

  return {
    geonode_sub_user_id: String(result.id ?? result.sub_user_id ?? username),
    username: result.username ?? username,
    password: result.password ?? password,
    host: PROXY_HOST,
    port,
    protocol: p.protocol ?? 'http',
  }
}

export async function getSubUserUsage(geonodeSubUserId: string): Promise<number> {
  const res = await fetch(
    `${BASE}/${RESELLER_ID}/sub-users/${geonodeSubUserId}/usage`,
    { headers: headers() }
  )
  if (!res.ok) return 0
  const d = await res.json()
  const result = d.data ?? d
  const usedMb = result.usedMB ?? result.used_mb ?? result.bandwidth_used_mb ?? 0
  return mbToGb(usedMb)
}

export async function getAccountBalance(): Promise<{ available_gb: number; total_gb: number }> {
  const res = await fetch(
    `${BASE}/${RESELLER_ID}/services/${SERVICE_TYPE}/traffic/summary`,
    { headers: headers() }
  )
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    console.error('Geonode getAccountBalance failed:', res.status, errText)
    // Throw instead of returning zeros — a 0GB balance that's actually an
    // auth/endpoint failure is indistinguishable from a genuinely empty
    // account otherwise, which is how this stayed hidden before.
    throw new Error(`Geonode getAccountBalance failed: ${res.status} ${errText}`)
  }
  const d = await res.json()
  const result = d.data ?? d
  // NOTE: remainingMB/totalMB are our best guess at Geonode's field names —
  // unverified against a live response. If balance still reads 0 after this
  // fix, hit GET /api/admin/debug-geonode and check raw_response for the
  // actual field names, then update the two lines below.
  const remainingMb = result.remainingMB ?? result.remaining_mb ?? result.available_mb ?? 0
  const totalMb = result.totalMB ?? result.total_mb ?? 0
  return {
    available_gb: mbToGb(remainingMb),
    total_gb: mbToGb(totalMb),
  }
}

export async function purchaseBandwidth(gb: number): Promise<void> {
  const res = await fetch(`${BASE}/${RESELLER_ID}/services/${SERVICE_TYPE}/purchase`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ mb_amount: Math.round(gb * 1024) }),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    console.error('Geonode purchaseBandwidth failed:', res.status, errText)
    // Previously swallowed — reload-stock/route.ts would report success and
    // email you a confirmation even when this call failed outright.
    throw new Error(`Geonode purchaseBandwidth failed: ${res.status} ${errText}`)
  }
}

export async function deleteSubUser(geonodeSubUserId: string): Promise<void> {
  await fetch(`${BASE}/${RESELLER_ID}/sub-users/${geonodeSubUserId}`, {
    method: 'DELETE',
    headers: headers(),
  })
}

// ─── Debug only — admin diagnostic endpoint ──────────────────────────────────
// Creates a 10 MB test sub-user, captures the full raw Geonode response,
// then immediately deletes it. Used by /api/admin/debug-geonode to verify:
//   1. API key and reseller ID are valid
//   2. Exact field names Geonode returns (id vs sub_user_id, etc.)
//   3. bandwidth_limit_mb is the correct request field name
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
    bandwidth_limit_mb: 10, // 10 MB — smallest testable amount
    country: null,
    state: null,
    city: null,
    protocol: 'http',
    session_type: 'rotating',
  }

  let httpStatus: number | null = null
  let rawResponse: object | null = null
  let parsedGcred: GCred | null = null
  let cleanupDeleted = false
  let error: string | null = null

  try {
    const res = await fetch(`${BASE}/${RESELLER_ID}/sub-users`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(requestBody),
    })
    httpStatus = res.status
    const text = await res.text()
    try { rawResponse = JSON.parse(text) } catch { rawResponse = { raw_text: text } }

    if (res.ok && rawResponse) {
      const d = rawResponse as any
      const result = d.data ?? d
      parsedGcred = {
        geonode_sub_user_id: String(result.id ?? result.sub_user_id ?? username),
        username: result.username ?? username,
        password: result.password ?? password,
        host: PROXY_HOST,
        port: 9000,
        protocol: 'http',
      }

      // Immediately clean up — don't leave test sub-users in Geonode
      try {
        const delRes = await fetch(
          `${BASE}/${RESELLER_ID}/sub-users/${parsedGcred.geonode_sub_user_id}`,
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
