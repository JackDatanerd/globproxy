const BASE = 'https://app-api.geonode.com/api/reseller/v2'
const KEY  = process.env.GEONODE_API_KEY!

// White-label host — always expose this to users, never residential.geonode.com
export const PROXY_HOST = 'proxy.globproxy.com'

function headers() {
  return {
    'r-api-key': KEY,
    'Content-Type': 'application/json',
  }
}

function unwrap(d: any) {
  // Geonode API wraps all responses in { data: ... }
  return d?.data ?? d
}

function genPassword(): string {
  const c = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  return Array.from({ length: 16 }, () => c[Math.floor(Math.random() * c.length)]).join('')
}

export interface GCred {
  username: string
  password: string
  host: string       // always proxy.globproxy.com
  port: number       // 9000 (http) or 7000 (socks5)
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

  const res = await fetch(`${BASE}/sub-users`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      username,
      password,
      bandwidth_limit_gb: p.gb_limit,
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
    console.error('Geonode createSubUser failed:', res.status, err)
    return { username, password, host: PROXY_HOST, port, protocol: p.protocol ?? 'http' }
  }

  const raw = await res.json()
  const d = unwrap(raw)
  return {
    username: d.username ?? username,
    password: d.password ?? password,
    host: PROXY_HOST,
    port,
    protocol: p.protocol ?? 'http',
  }
}

export async function getSubUserUsage(username: string): Promise<number> {
  const res = await fetch(`${BASE}/sub-users/${username}/usage`, { headers: headers() })
  if (!res.ok) return 0
  const raw = await res.json()
  const d = unwrap(raw)
  return d.used_gb ?? d.usedGb ?? 0
}

export async function getAccountBalance(): Promise<{ available_gb: number; total_gb: number }> {
  const res = await fetch(`${BASE}/account/balance`, { headers: headers() })
  if (!res.ok) {
    console.error('Geonode getAccountBalance failed:', res.status, await res.text().catch(() => ''))
    return { available_gb: 0, total_gb: 0 }
  }
  const raw = await res.json()
  const d = unwrap(raw)
  return {
    available_gb: d.available_gb ?? d.availableGb ?? d.available ?? 0,
    total_gb: d.total_gb ?? d.totalGb ?? d.total ?? 0,
  }
}

export async function purchaseBandwidth(gb: number): Promise<void> {
  const res = await fetch(`${BASE}/account/purchase`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ gb_amount: gb }),
  })
  if (!res.ok) {
    console.error('Geonode purchaseBandwidth failed:', res.status, await res.text().catch(() => ''))
  }
}

export async function deleteSubUser(username: string): Promise<void> {
  await fetch(`${BASE}/sub-users/${username}`, {
    method: 'DELETE',
    headers: headers(),
  })
}
