import { NextResponse } from 'next/server'
import { MFA_COOKIE_NAME, MFA_COOKIE_MAX_AGE_S } from '@/lib/mfa'

// Shared by confirm/verify/password — every place that issues the cookie at
// the same trust point (a code was just checked successfully), kept in one
// spot so the shape can't drift. maxAge follows the session's own TTL
// ("trust this browser" sessions live 30 days, normal ones 12h).
export function withMfaCookie(res: NextResponse, token: string, maxAgeS: number = MFA_COOKIE_MAX_AGE_S): NextResponse {
  res.cookies.set(MFA_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeS,
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
