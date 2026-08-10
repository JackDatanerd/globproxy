import { revokeVerifiedSession, MFA_COOKIE_NAME } from '@/lib/mfa'
import { clearMfaCookie } from '../_cookie'
import { NextResponse } from 'next/server'

// Supabase's own auth.signOut() (called client-side, see DashTopbar) has
// no idea our separate gp_mfa cookie exists, so it never clears it. Left
// alone, a shared/public machine would keep the browser "MFA-verified"
// for up to the cookie's remaining TTL even after the account itself
// signed out — whoever signs back in (same account or, worse, a
// different one after a password reset on the same device) would skip
// the second factor entirely until the cookie's natural expiry.
export async function POST(req: Request) {
  const cookieToken = req.headers.get('cookie')
    ?.split(';')
    .map(c => c.trim())
    .find(c => c.startsWith(`${MFA_COOKIE_NAME}=`))
    ?.slice(MFA_COOKIE_NAME.length + 1)

  await revokeVerifiedSession(cookieToken)

  const res = NextResponse.json({ success: true })
  return clearMfaCookie(res)
}
