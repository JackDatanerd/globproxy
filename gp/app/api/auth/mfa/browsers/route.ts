import { rejectCrossSite } from '@/lib/apiAuth'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { listTrustedBrowsers, revokeTrustedBrowser, getMfaCookieFromRequest } from '@/lib/mfa'
import { logSecurityEvent } from '@/lib/securityEvents'
import { rateLimited } from '@/lib/rateLimit'
import { NextResponse } from 'next/server'

// Browsers that completed the second factor ("verified" for 12 h, or
// "trusted" for 30 days). Listing them and revoking one at a time replaces
// the all-or-nothing "sign out everywhere".
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    return NextResponse.json({ browsers: await listTrustedBrowsers(user.id, getMfaCookieFromRequest(req)) })
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'Could not load your trusted browsers.' }, { status: 503 })
  }
}

export async function DELETE(req: Request) {
  const cross = rejectCrossSite(req)
  if (cross) return cross

  const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', 'mfa')
  if (limited) return limited
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await req.json().catch(() => ({}))
  if (typeof id !== 'string') return NextResponse.json({ error: 'Missing browser id.' }, { status: 400 })
  try {
    const removed = await revokeTrustedBrowser(user.id, id)
    if (removed) await logSecurityEvent({ userId: user.id, event: 'mfa_browser_revoked', req, admin: await createAdminClient() })
    return NextResponse.json({ success: true, removed })
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'Could not revoke that browser.' }, { status: 500 })
  }
}
