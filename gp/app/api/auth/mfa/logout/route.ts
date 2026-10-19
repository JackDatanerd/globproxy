import { revokeVerifiedSession, getMfaCookieFromRequest } from '@/lib/mfa'
import { clearMfaCookie } from '../_cookie'
import { RECOVERY_COOKIE_NAME } from '@/lib/recoveryCookie'
import { SUDO_COOKIE_NAME } from '@/lib/reauth'
import { NextResponse } from 'next/server'

// Supabase's own auth.signOut() (called client-side) has no idea our separate
// gp_mfa cookie exists, so it never clears it. Left alone, a shared/public
// machine would keep the browser "MFA-verified" for up to the cookie's
// remaining TTL (up to 30 days with "trust this browser") even after the
// account signed out. Every sign-out path calls this first.
export async function POST(req: Request) {
  await revokeVerifiedSession(getMfaCookieFromRequest(req))
  const res = NextResponse.json({ success: true })
  // Also drop the other short-lived proofs: a password-recovery marker or a
  // password re-entry must not outlive the session that earned it.
  for (const name of [RECOVERY_COOKIE_NAME, SUDO_COOKIE_NAME]) {
    res.cookies.set(name, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 0 })
  }
  return clearMfaCookie(res)
}
