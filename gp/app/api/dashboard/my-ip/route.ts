import { createClient } from '@/lib/supabase/server'
import { isValidIp } from '@/lib/ipWhitelist'
import { NextResponse } from 'next/server'
import { requireActiveUser } from '@/lib/apiAuth'

// Returns the caller's public IP as this app sees it, so the whitelist tab
// can offer "use my current IP" instead of sending people to a what's-my-ip
// site and back. cf-connecting-ip is set by Cloudflare itself (this app is
// deployed on Workers); x-forwarded-for is the fallback for local/dev.
// Authenticated so it isn't an open IP-echo endpoint, and never cached.
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended

  const raw =
    req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0] ||
    ''
  const ip = raw.trim()
  if (!ip || !isValidIp(ip)) {
    return NextResponse.json({ error: 'Couldn\u2019t determine your IP address.' }, { status: 404 })
  }
  // An IPv6 address is the one this browser reached us over; proxy clients often connect over IPv4, in
  // which case the whitelisted address would never match. The page warns on `family: 'ipv6'`.
  const family = ip.includes(':') ? 'ipv6' : 'ipv4'
  return NextResponse.json({ ip, family }, { headers: { 'Cache-Control': 'no-store' } })
}
