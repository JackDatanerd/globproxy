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
