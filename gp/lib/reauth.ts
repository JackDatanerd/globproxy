import { NextResponse } from 'next/server'
import { mfaGate } from '@/lib/mfa'

// "Sudo mode" for accounts WITHOUT two-factor authentication.
//
// 2FA is optional, so most accounts have no step-up at all: a stolen session
// could mint API keys, add webhook endpoints, redirect a payout method,
// delete the account or attach an attacker's authenticator. For those
// actions the server now asks for the account password again. A correct
// password (POST /api/auth/reauth) sets a short-lived signed cookie; the
// gated routes accept it for SUDO_TTL_S.
//
// Accounts that HAVE 2FA are unchanged: the TOTP step-up (requireMfaVerified)
// already covers them and they are never asked for a password here.
//
// Value: `<userId>.<expiresAtMs>.<hmac>`, HMAC-SHA256 keyed from the
// service-role key (same approach as lib/recoveryCookie.ts).
export const SUDO_COOKIE_NAME = 'gp_sudo'
export const SUDO_TTL_S = 10 * 60

const enc = new TextEncoder()

async function sign(payload: string): Promise<string> {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
  // Fail closed: an empty key would make every cookie forgeable.
  if (!secret) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set; refusing to sign cookies')
  const key = await crypto.subtle.importKey('raw', enc.encode(`gp-sudo:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload))
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function makeSudoCookieValue(userId: string): Promise<string> {
  const payload = `${userId}.${Date.now() + SUDO_TTL_S * 1000}`
  return `${payload}.${await sign(payload)}`
}

export async function verifySudoCookieValue(value: string | undefined, userId: string): Promise<boolean> {
  if (!value) return false
  const parts = value.split('.')
  if (parts.length !== 3) return false
  const [uid, expStr, mac] = parts
  if (uid !== userId) return false
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || exp < Date.now()) return false
  try {
    return timingSafeEqual(mac, await sign(`${uid}.${expStr}`))
  } catch {
    return false
  }
}

/** Expire the sudo cookie (sign-out, password change). */
export function clearSudoCookie(res: NextResponse): NextResponse {
  res.cookies.set(SUDO_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })
  return res
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get('cookie')
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) {
      const raw = part.slice(eq + 1).trim()
      try { return decodeURIComponent(raw) } catch { return raw }
    }
  }
  return undefined
}

/**
 * Gate for sensitive actions. Returns a NextResponse to send back, or null to
 * continue.
 *   - enrolled in 2FA  -> must hold a verified-browser cookie (403 mfa_required)
 *   - not enrolled     -> must have re-entered the password in the last
 *                         SUDO_TTL_S seconds (403 reauth_required)
 */
export async function requireStepUp(req: Request, userId: string): Promise<NextResponse | null> {
  const { response, enrolled } = await mfaGate(req, userId)
  if (response) return response
  if (enrolled) return null
  if (await verifySudoCookieValue(readCookie(req, SUDO_COOKIE_NAME), userId)) return null
  return NextResponse.json(
    { error: 'Please confirm your password to continue.', code: 'reauth_required' },
    { status: 403 }
  )
}
