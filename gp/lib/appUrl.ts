// One place that turns NEXT_PUBLIC_APP_URL into something safe to put in an
// email. The old pattern `${process.env.NEXT_PUBLIC_APP_URL}/path` rendered
// "undefined/path" when the variable was missing.
export function appUrl(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL?.trim()
  if (raw) {
    try { return new URL(raw).origin } catch { /* fall through */ }
  }
  return 'https://globproxy.com'
}

/** The URL if it lives on our own origin, else undefined (open-redirect guard for client-supplied redirect targets). */
export function sameOriginUrl(candidate: unknown): string | undefined {
  if (typeof candidate !== 'string' || !candidate) return undefined
  try {
    return new URL(candidate).origin === appUrl() ? candidate : undefined
  } catch {
    return undefined
  }
}

/**
 * True when a browser-supplied Origin header names some other site. Cookie-
 * authenticated state-changing routes use it as a CSRF guard; requests with no
 * Origin header (non-browser clients) are not judged here.
 */
export function isCrossSiteRequest(req: Request): boolean {
  const origin = req.headers.get('origin')
  if (!origin) return false
  try {
    const o = new URL(origin).origin
    return o !== new URL(req.url).origin && o !== appUrl()
  } catch {
    return true
  }
}
