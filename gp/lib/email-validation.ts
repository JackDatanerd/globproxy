import { DISPOSABLE_EMAIL_DOMAINS } from '@/lib/disposableDomains'

const BLOCKED = new Set<string>(DISPOSABLE_EMAIL_DOMAINS)

export function isDisposableDomain(domain: string): boolean {
  // A fully-qualified trailing dot (mailinator.com.) names the same domain.
  const d = domain.toLowerCase().replace(/\.+$/, '')
  if (BLOCKED.has(d)) return true
  // Subdomains of a blocked domain (abc.mailinator.com) count too.
  const parts = d.split('.')
  for (let i = 1; i < parts.length - 1; i++) {
    if (BLOCKED.has(parts.slice(i).join('.'))) return true
  }
  return false
}

// Zero-width, bidi-control, soft-hyphen and other invisible characters. `\s` does not match them,
// so a domain like "mailinator.com<ZWSP>" looked like a different, allowed domain.
const INVISIBLE = /[\p{Cc}\p{Cf}\u2028\u2029]/u

export function validateEmail(email: string): { valid: boolean; error?: string } {
  if (email.length > 254) return { valid: false, error: 'Please enter a valid email address.' }
  if (INVISIBLE.test(email)) return { valid: false, error: 'Please enter a valid email address.' }
  const domain = email.split('@')[1]?.toLowerCase()
  if (!domain || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { valid: false, error: 'Please enter a valid email address.' }
  // "x@mailinator.com." / "x@.com" / "x@a..com": never a real mailbox, and the first form
  // slipped past the disposable-domain list (the list holds "mailinator.com", not "mailinator.com.").
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return { valid: false, error: 'Please enter a valid email address.' }
  if (isDisposableDomain(domain)) return { valid: false, error: 'Disposable email addresses are not allowed. Please use a real email.' }
  return { valid: true }
}

/** Collapse plus-addressing so `bad+1@x.com` matches a ban on `bad@x.com`. Mirrors public.normalize_ban_email(). */
export function normalizeForBan(email: string): string {
  const [local = '', domain = ''] = email.trim().toLowerCase().split('@')
  return `${local.replace(/\+.*$/, '')}@${domain}`
}
