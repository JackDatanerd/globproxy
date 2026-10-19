import { createHash } from 'crypto'

// Shared by the /r/[code] redirect, the signup page and the signup API.
export const REF_COOKIE = 'gp_ref'
export const REF_SUB_COOKIE = 'gp_sub'
export const REF_COOKIE_MAX_AGE_S = 60 * 60 * 24 * 60 // 60 days

// Codes are 8 hex chars today (generate_unique_referral_code); accept a
// slightly wider range so a future format change doesn't silently drop
// attribution, but never anything that could carry markup/whitespace.
const CODE_RE = /^[A-Za-z0-9]{4,32}$/
const SUB_RE = /^[A-Za-z0-9_-]{1,32}$/

export function cleanReferralCode(v: unknown): string | null {
  return typeof v === 'string' && CODE_RE.test(v.trim()) ? v.trim().toUpperCase() : null
}

export function cleanSubId(v: unknown): string | null {
  return typeof v === 'string' && SUB_RE.test(v.trim()) ? v.trim() : null
}

export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) {
      try {
        return decodeURIComponent(rest.join('='))
      } catch {
        return null
      }
    }
  }
  return null
}

// One-way hash of the signup IP — enough to notice "the same person signed
// up five times from one address" without storing the address itself.
export function hashIp(ip: string | null | undefined): string | null {
  if (!ip || ip === 'unknown') return null
  const salt = process.env.REFERRAL_IP_SALT || process.env.CRON_SECRET || 'gp-referral'
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 32)
}
