const BASE = 'https://app-api.geonode.com/api/reseller/v2'
const KEY = process.env.GEONODE_API_KEY!
const RESELLER_ID = process.env.GEONODE_RESELLER_ID!
const SERVICE_TYPE = 'RESIDENTIAL-PREMIUM'

// White-label host — always expose this to users, never residential.geonode.com
// NOTE: proxy.globproxy.com must be DNS-configured to route to Geonode's
// proxy infrastructure (CNAME or a transparent proxy). Verify in Geonode
// reseller dashboard under "Custom Hostname" before going live.
export const PROXY_HOST = 'proxy.globproxy.com'

function headers() {
  return {
    'r-api-key': KEY,
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
  geonode_sub_user_id: string  // Geonode's own numeric ID — required for usage/delete lookups
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
  sticky_duration?: number  // minutes
}

export async function createSubUser(p: CreateSubUserParams): Promise<GCred> {
  const username = `gp_${Date.now()}`
  const password = genPassword()
  const port = p.protocol === 'socks5' ? 7000 : 9000

  // NOTE: bandwidth_limit_mb is our best guess at the field name.
  // If sub-user creation returns 400/422, run POST /api/admin/debug-geonode
  // and check `raw_response` to see the exact error — Geonode will name the
  // offending field. Common alternatives: trafficLimitMB, traffic_limit_mb, quota_mb.
  const body: Record<string, unknown> = {
    username,
    password,
    bandwidth_limit_mb: Math.round(p.gb_limit * 1024),
    protocol: p.protocol ?? 'http',
    session_type: p.session_type ?? 'rotating',
  }

  // Only include geo fields when set — sending null may cause Geonode 400s
  if (p.country) body.country = p.country
  if (p.state) body.state = p.state
  if (p.city) body.city = p.city
  // sticky_duration: Geonode expects seconds, we receive minutes
  if (p.sticky_duration) body.sticky_duration = p.sticky_duration * 60

  const res = await fetch(`${BASE}/${RESELLER_ID}/sub-users`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Geonode createSubUser failed: ${res.status} ${JSON.stringify(err)}`)
  }

  const d = await res.json()
  const result = d.data ?? d  // unwrap { data: ... } envelope

  return {
    // Cover the three ID field names seen across Geonode API versions
    geonode_sub_user_id: String(result.id ?? result.sub_user_id ?? result.userId ?? username),
    username: result.username ?? username,
    password: result.password ?? password,
    host: PROXY_HOST,
    port,
    protocol: p.protocol ?? 'http',
  }
}

export async function getSubUserUsage(geonodeSubUserId: string): Promise<number> {
  // geonodeSubUserId must be the numeric ID returned by createSubUser,
  // stored as geonode_sub_user_id in proxy_credentials — NOT the username string.
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
    // FIXED: was silently returning {0, 0}. Now throws so sync-stock surfaces
    // the real error (bad key, wrong reseller ID, etc.) instead of writing
    // a false zero-balance to platform_settings.
    const body = await res.text().catch(() => '')
    throw new Error(`Geonode getAccountBalance failed: ${res.status} — ${body}`)
  }
  const d = await res.json()
  const result = d.data ?? d
  return {
    // availableForAllocationMB is a secondary fallback seen in some Geonode
    // API versions when remainingMB is absent
    available_gb: mbToGb(result.remainingMB ?? result.availableForAllocationMB ?? 0),
    total_gb: mbToGb(result.totalMB ?? 0),
  }
}

export async function deleteSubUser(geonodeSubUserId: string): Promise<void> {
  // geonodeSubUserId must be the numeric ID — same requirement as getSubUserUsage.
  const res = await fetch(`${BASE}/${RESELLER_ID}/sub-users/${geonodeSubUserId}`, {
    method: 'DELETE',
    headers: headers(),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Geonode deleteSubUser failed: ${res.status} — ${body}`)
  }
}

export async function purchaseBandwidth(gb: number): Promise<void> {
  const res = await fetch(`${BASE}/${RESELLER_ID}/services/${SERVICE_TYPE}/purchase`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ mb_amount: Math.round(gb * 1024) }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Geonode purchaseBandwidth failed: ${res.status} — ${body}`)
  }
}

// ---------------------------------------------------------------------------
// Diagnostic helper — used exclusively by /api/admin/debug-geonode
// Creates a 10 MB sub-user, returns the full raw response, then deletes it.
// Never call this from production flows.
// ---------------------------------------------------------------------------
export async function debugCreateSubUser(): Promise<{
  request_body: object
  status: number
  raw_response: unknown
  parsed_gcred?: Omit<GCred, 'host' | 'port' | 'protocol'>
  cleanup_deleted: boolean
  error?: string
}> {
  const username = `gp_dbg_${Date.now()}`
  const password = genPassword()
  const body = {
    username,
    password,
    bandwidth_limit_mb: 10,  // minimal — 10 MB
    protocol: 'http',
    session_type: 'rotating',
  }

  const res = await fetch(`${BASE}/${RESELLER_ID}/sub-users`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  })

  const rawText = await res.text()
  let rawJson: unknown
  try { rawJson = JSON.parse(rawText) } catch { rawJson = rawText }

  if (!res.ok) {
    return {
      request_body: body,
      status: res.status,
      raw_response: rawJson,
      cleanup_deleted: false,
      error: `HTTP ${res.status}`,
    }
  }

  const d = rawJson as Record<string, unknown>
  const result = (d?.data ?? d) as Record<string, unknown>

  const gcredId = String(result?.id ?? result?.sub_user_id ?? result?.userId ?? username)

  // Immediately delete to avoid accumulating dead test sub-users
  let cleanup_deleted = false
  try {
    await deleteSubUser(gcredId)
    cleanup_deleted = true
  } catch (e) {
    console.error('[debug] Failed to delete test sub-user:', gcredId, e)
  }

  return {
    request_body: body,
    status: res.status,
    raw_response: rawJson,
    parsed_gcred: {
      geonode_sub_user_id: gcredId,
      username: String(result?.username ?? username),
      password: String(result?.password ?? password),
    },
    cleanup_deleted,
  }
}
