// The signed-in areas, in ONE place. middleware.ts (auth + MFA gate + nonce CSP) and
// next.config.ts (which must NOT send the static CSP there) both read this, so the two
// can no longer drift. Import-free: next.config.ts loads it through a relative import.

export const PROTECTED_PREFIXES = ['/dashboard', '/reseller', '/admin', '/invoice'] as const

/**
 * Whole-segment match: `/admin` and `/admin/users` are protected, `/administrator`,
 * `/dashboards` and `/reseller-program` are not. A plain startsWith() treated those as
 * signed-in pages, which would have forced any future public page that merely starts with
 * those letters through the login gate and the signed-in CSP.
 */
export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))
}

/** next.config.ts `headers()` source matching every path EXCEPT the protected areas (whole segments, like isProtectedPath). */
export function unprotectedSource(): string {
  const names = PROTECTED_PREFIXES.map((p) => p.slice(1)).join('|')
  return `/((?!(?:${names})(?:/|$)).*)`
}
