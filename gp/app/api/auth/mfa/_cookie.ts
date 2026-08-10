import { NextResponse } from 'next/server'
import { MFA_COOKIE_NAME, MFA_COOKIE_MAX_AGE_S } from '@/lib/mfa'

// Shared by confirm/route.ts and verify/route.ts — both issue the exact
// same cookie shape at the exact same trust point (a code was just
// checked successfully), so this exists purely to keep that shape from
// drifting between the two call sites over time.
export function withMfaCookie(res: NextResponse, token: string): NextResponse {
  res.cookies.set(MFA_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: MFA_COOKIE_MAX_AGE_S,
  })
  return res
}

export function clearMfaCookie(res: NextResponse): NextResponse {
  res.cookies.set(MFA_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })
  return res
}
