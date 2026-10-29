// Signed one-click unsubscribe links for broadcast e-mail.
//
// The link carries the account id and an HMAC of it, so it works without signing in (a mail client's
// "Unsubscribe" button, or the footer link, must) and cannot be forged for someone else's account.
// Import-free apart from the Web Crypto global, so it runs in the Worker and under `node --test`.
//
// The signing key is passed in (never read from the environment here) and the signed message is
// domain-separated ("unsubscribe:v1:") so the same secret can never produce a token that means
// something else.

const enc = new TextEncoder()

function b64url(bytes: ArrayBuffer): string {
  let s = ''
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function mac(secret: string, userId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(`unsubscribe:v1:${userId}`)))
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function signUnsubscribe(secret: string, userId: string): Promise<string> {
  if (!secret) throw new Error('no unsubscribe secret configured')
  return mac(secret, userId)
}

/** Constant-time check of a token for an account id. A malformed id or empty secret never verifies. */
export async function verifyUnsubscribe(secret: string, userId: string, token: string): Promise<boolean> {
  if (!secret || !UUID.test(userId) || typeof token !== 'string' || token.length < 20 || token.length > 100) return false
  const expected = await mac(secret, userId)
  if (expected.length !== token.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i)
  return diff === 0
}

export async function unsubscribeUrl(origin: string, secret: string, userId: string): Promise<string> {
  const t = await signUnsubscribe(secret, userId)
  return `${origin.replace(/\/+$/, '')}/api/unsubscribe?u=${encodeURIComponent(userId)}&t=${encodeURIComponent(t)}`
}
