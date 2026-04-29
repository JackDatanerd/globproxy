const BASE = 'https://api.geonode.com/v1'
const KEY = process.env.GEONODE_API_KEY!

function headers() {
  return {
    Authorization: `Bearer ${KEY}`,
    'Content-Type': 'application/json',
  }
}

function genPassword(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#'
  return Array.from({ length: 16 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

export interface GCred {
  username: string
  password: string
  host: string
  port: number
}

export async function createSubUser(p: {
  label: string
  gb_limit: number
  country?: string
  state?: string
  city?: string
  protocol?: 'http' | 'socks5'
}): Promise<GCred> {
  const res = await fetch(`${BASE}/sub-users`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      username: `gp_${Date.now()}`,
      password: genPassword(),
      bandwidth_limit_gb: p.gb_limit,
      country: p.country ?? null,
      state: p.state ?? null,
      city: p.city ?? null,
    }),
  })
  const d = await res.json()
  const port = p.protocol === 'socks5' ? 7000 : 9000
  return {
    username: d.username,
    password: d.password,
    host: 'proxy.globproxy.com',
    port,
  }
}

export async function getSubUserUsage(username: string): Promise<number> {
  const res = await fetch(`${BASE}/sub-users/${username}/usage`, { headers: headers() })
  const d = await res.json()
  return d.used_gb ?? 0
}

export async function getAccountBalance(): Promise<{ available_gb: number; total_gb: number }> {
  const res = await fetch(`${BASE}/account/balance`, { headers: headers() })
  const d = await res.json()
  return { available_gb: d.available_gb ?? 0, total_gb: d.total_gb ?? 0 }
}

export async function purchaseBandwidth(gb: number): Promise<void> {
  await fetch(`${BASE}/account/purchase`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ gb_amount: gb }),
  })
}
