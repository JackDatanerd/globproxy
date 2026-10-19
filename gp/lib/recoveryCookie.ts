// Marks "this session was just created by clicking a password-RECOVERY email
// link". /api/auth/password uses it to decide whether the caller may set a new
// password WITHOUT supplying the current one (they proved control of the
// mailbox instead). A normal signed-in session must supply the current
// password — otherwise a stolen session token could simply set a new password.
//
// Value: `<userId>.<expiresAtMs>.<hmac>`, HMAC-SHA256 keyed from the
// service-role key (server-only secret, so no extra env var is needed).
export const RECOVERY_COOKIE_NAME = 'gp_recovery'
export const RECOVERY_TTL_S = 30 * 60

const enc = new TextEncoder()

async function sign(payload: string): Promise<string> {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  const key = await crypto.subtle.importKey('raw', enc.encode(`gp-recovery:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload))
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function makeRecoveryCookieValue(userId: string): Promise<string> {
  const exp = Date.now() + RECOVERY_TTL_S * 1000
  const payload = `${userId}.${exp}`
  return `${payload}.${await sign(payload)}`
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function verifyRecoveryCookieValue(value: string | undefined, userId: string): Promise<boolean> {
  if (!value) return false
  const parts = value.split('.')
  if (parts.length !== 3) return false
  const [uid, expStr, mac] = parts
  if (uid !== userId) return false
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || exp < Date.now()) return false
  return timingSafeEqual(mac, await sign(`${uid}.${expStr}`))
}
