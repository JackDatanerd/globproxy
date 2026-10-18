import { revokeVerifiedSession, getMfaCookieFromRequest } from '@/lib/mfa'
import { clearMfaCookie } from '../_cookie'
import { NextResponse } from 'next/server'

// Supabase's own auth.signOut() (called client-side) has no idea our separate
// gp_mfa cookie exists, so it never clears it. Left alone, a shared/public
// machine would keep the browser "MFA-verified" for up to the cookie's
// remaining TTL (up to 30 days with "trust this browser") even after the
// account signed out. Every sign-out path calls this first.
export async function POST(req: Request) {
  await revokeVerifiedSession(getMfaCookieFromRequest(req))
  const res = NextResponse.json({ success: true })
  return clearMfaCookie(res)
}
