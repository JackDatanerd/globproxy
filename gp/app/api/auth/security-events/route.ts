import { requireActiveUser } from '@/lib/apiAuth'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireMfaVerified } from '@/lib/mfa'
import { NextResponse } from 'next/server'

// The signed-in user's recent security activity (sign-ins, 2FA changes, password
// and e-mail changes ...). It lists the IP address and browser of every sign-in,
// so it gets the same 2FA gate as /api/auth/sessions: a password-only session on
// a 2FA account must not be able to read it. The browser no longer queries
// security_events directly (the "Own security events" RLS policy was dropped in
// migration 0101), so this route is the only way to read it.
//
// Only a fixed set of fields is returned: actor_id (the admin who acted, on an
// admin 2FA reset) and the raw meta blob never leave the server.
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const inactive = await requireActiveUser(user.id)
  if (inactive) return inactive
  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock

  const admin = await createAdminClient()
  const { data, error } = await admin
    .from('security_events')
    .select('id, event, ip, user_agent, created_at, country:meta->>country')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) {
    console.error('[auth/security-events] load failed', user.id, error.message)
    return NextResponse.json({ error: 'Could not load your activity right now.' }, { status: 503 })
  }
  return NextResponse.json({ events: data ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
}
