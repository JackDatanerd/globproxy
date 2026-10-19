import { DISPOSABLE_EMAIL_DOMAINS } from '@/lib/disposableDomains'

const BLOCKED = new Set<string>(DISPOSABLE_EMAIL_DOMAINS)

export function isDisposableDomain(domain: string): boolean {
  const d = domain.toLowerCase()
  if (BLOCKED.has(d)) return true
  // Subdomains of a blocked domain (abc.mailinator.com) count too.
  const parts = d.split('.')
  for (let i = 1; i < parts.length - 1; i++) {
    if (BLOCKED.has(parts.slice(i).join('.'))) return true
  }
  return false
}

export function validateEmail(email: string): { valid: boolean; error?: string } {
  if (email.length > 254) return { valid: false, error: 'Please enter a valid email address.' }
  const domain = email.split('@')[1]?.toLowerCase()
  if (!domain || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { valid: false, error: 'Please enter a valid email address.' }
  if (isDisposableDomain(domain)) return { valid: false, error: 'Disposable email addresses are not allowed. Please use a real email.' }
  return { valid: true }
}

/** Collapse plus-addressing so `bad+1@x.com` matches a ban on `bad@x.com`. Mirrors public.normalize_ban_email(). */
export function normalizeForBan(email: string): string {
  const [local = '', domain = ''] = email.trim().toLowerCase().split('@')
  return `${local.replace(/\+.*$/, '')}@${domain}`
}
