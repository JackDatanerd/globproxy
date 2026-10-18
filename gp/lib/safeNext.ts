// A bare `next` query param must never be trusted as-is — `next=https://evil.com`,
// `next=//evil.com`, `next=/\evil.com` and `next=https://real@evil.com` are all
// open-redirect payloads that would send a freshly-authenticated user off-platform
// straight from a trusted globproxy.com link. Anything that isn't a single
// same-site absolute path falls back to `fallback`.
export function safeNextPath(raw: string | null | undefined, fallback = '/dashboard'): string {
  if (!raw) return fallback
  if (raw.length > 512) return fallback
  // exactly one leading '/', never '//', no backslashes/whitespace/control chars
  if (!/^\/(?!\/)[^\s\\\u0000-\u001f]*$/.test(raw)) return fallback
  if (raw.includes('@') || raw.includes('://')) return fallback
  // never bounce back into the auth plumbing
  if (raw.startsWith('/api/') || raw.startsWith('/auth/')) return fallback
  return raw
}
