const BASE = 'https://app-api.geonode.com/api/reseller/v2'
const KEY  = process.env.GEONODE_API_KEY!
const RESELLER_ID = process.env.GEONODE_RESELLER_ID!
const SERVICE_TYPE = 'RESIDENTIAL-PREMIUM'

// White-label host — always expose this to users, never residential.geonode.com
export const PROXY_HOST = 'proxy.globproxy.com'

function headers() {
  return {
    'Reseller-Api-Key': KEY,
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
    console.error('Geonode createSubUser failed:', res.status, err)
    return { username, password, host: PROXY_HOST, port, protocol: p.protocol ?? 'http' }
  }

  const d = await res.json()
  const result = d.result ?? d
  return {
    username: result.username ?? username,
    password: result.password ?? password,
    host: PROXY_HOST,
    port,
    protocol: p.protocol ?? 'http',
  }
}

export async function getSubUserUsage(username: string): Promise<number> {
  const res = await fetch(`${BASE}/${RESELLER_ID}/sub-users/${username}/usage`, { headers: headers() })
  if (!res.ok) return 0
  const d = await res.json()
  const result = d.result ?? d
  const usedMb = result.usedMB ?? result.used_mb ?? 0
  return mbToGb(usedMb)
}

export async function getAccountBalance(): Promise<{ available_gb: number; total_gb: number }> {
  const res = await fetch(
    `${BASE}/${RESELLER_ID}/services/${SERVICE_TYPE}/traffic/summary`,
    { headers: headers() }
  )

  if (!res.ok) {
    console.error('Geonode getAccountBalance failed:', res.status, await res.text().catch(() => ''))
    return { available_gb: 0, total_gb: 0 }
  }

  const d = await res.json()
  const result = d.result ?? d
  return {
    available_gb: mbToGb(result.remainingMB ?? 0),
    total_gb: mbToGb(result.totalMB ?? 0),
  }
}

export async function purchaseBandwidth(gb: number): Promise<void> {
  const res = await fetch(`${BASE}/${RESELLER_ID}/services/${SERVICE_TYPE}/purchase`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ mb_amount: Math.round(gb * 1024) }),
  })
  if (!res.ok) {
    console.error('Geonode purchaseBandwidth failed:', res.status, await res.text().catch(() => ''))
  }
}

export async function deleteSubUser(username: string): Promise<void> {
  await fetch(`${BASE}/${RESELLER_ID}/sub-users/${username}`, {
    method: 'DELETE',
    headers: headers(),
  })
}
