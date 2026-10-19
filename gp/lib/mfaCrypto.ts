// At-rest protection for MFA material.
//
//  - TOTP secrets are encrypted with AES-256-GCM ("enc:v1:<iv>.<ciphertext>").
//    A database-only leak (backup, replica, SQL injection, a support
//    export) no longer hands over every user's authenticator seed.
//  - Backup codes are HMAC-SHA256'd with a key derived from the same
//    secret instead of plain SHA-256. A backup code has only ~40 bits of
//    entropy, so a leaked table of unsalted SHA-256 hashes could be
//    brute-forced in minutes; without the key an HMAC cannot be attacked
//    offline at all.
//
// Configuration: MFA_ENCRYPTION_KEY (any high-entropy string; generate with
// `openssl rand -base64 32`). It is OPTIONAL so deploying this code before
// the env var exists does not lock anyone out: with no key, secrets keep
// being stored/read in the legacy plaintext form and codes keep the legacy
// SHA-256 hash, with a one-time warning. Rows written in the legacy form are
// upgraded lazily on the next successful verification once a key is set.
//
// Rotation: set MFA_ENCRYPTION_KEY to the new value and move the old one to
// MFA_ENCRYPTION_KEY_PREVIOUS. Decryption tries both; the next successful
// TOTP verification of each account re-encrypts its secret under the new key
// (see secretNeedsRewrite). Backup-code hashes are one-way HMACs, so they
// can only be re-keyed by regenerating the set: keep the previous key until
// users have regenerated (or used up) their old codes. NEVER remove a key
// while rows still depend on it — those accounts could no longer verify.

const PREFIX = 'enc:v1:'
let warned = false

function currentKey(): string | null {
  const k = process.env.MFA_ENCRYPTION_KEY?.trim()
  return k ? k : null
}
function previousKey(): string | null {
  const k = process.env.MFA_ENCRYPTION_KEY_PREVIOUS?.trim()
  return k ? k : null
}

function warnOnce() {
  if (warned) return
  warned = true
  console.warn('[mfa] MFA_ENCRYPTION_KEY is not set — TOTP secrets are stored in plaintext and backup codes use unkeyed SHA-256. Set it (openssl rand -base64 32).')
}

const enc = new TextEncoder()
const dec = new TextDecoder()

function toB64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}
function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64)
  const out = new Uint8Array(new ArrayBuffer(s.length))
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}
function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function sha256Bytes(input: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', enc.encode(input))
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const raw = await sha256Bytes(`gp-mfa-aes:${secret}`)
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  const raw = await sha256Bytes(`gp-mfa-hmac:${secret}`)
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

export function isEncryptedSecret(stored: string): boolean {
  return stored.startsWith(PREFIX)
}

/** True when a key is configured, i.e. new writes will be encrypted. */
export function encryptionEnabled(): boolean {
  return currentKey() !== null
}

export async function encryptSecret(plain: string): Promise<string> {
  const key = currentKey()
  if (!key) { warnOnce(); return plain }
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(key), enc.encode(plain))
  return `${PREFIX}${toB64(iv)}.${toB64(new Uint8Array(ct))}`
}

export async function decryptSecret(stored: string): Promise<string> {
  if (!isEncryptedSecret(stored)) return stored // legacy plaintext row
  const body = stored.slice(PREFIX.length)
  const dot = body.indexOf('.')
  if (dot === -1) throw new MfaConfigError('Malformed encrypted MFA secret')
  const iv = fromB64(body.slice(0, dot))
  const ct = fromB64(body.slice(dot + 1))
  const keys = [currentKey(), previousKey()].filter((k): k is string => !!k)
  if (keys.length === 0) {
    throw new MfaConfigError('MFA secret is encrypted but MFA_ENCRYPTION_KEY is not configured')
  }
  for (const k of keys) {
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await aesKey(k), ct)
      return dec.decode(pt)
    } catch { /* try the next key */ }
  }
  throw new MfaConfigError('Could not decrypt MFA secret with the configured key(s)')
}

/** Raised for operator-side misconfiguration (missing / wrong key). Never shown to end users. */
export class MfaConfigError extends Error {}

/**
 * True when the stored value should be rewritten under the current key:
 * legacy plaintext, or encrypted under the PREVIOUS key (not decryptable
 * with the current one). Without the second case a rotation could never
 * complete and the previous key could never be retired.
 */
export async function secretNeedsRewrite(stored: string): Promise<boolean> {
  if (!encryptionEnabled()) return false
  if (!isEncryptedSecret(stored)) return true
  const body = stored.slice(PREFIX.length)
  const dot = body.indexOf('.')
  if (dot === -1) return false
  try {
    const iv = fromB64(body.slice(0, dot))
    const ct = fromB64(body.slice(dot + 1))
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await aesKey(currentKey()!), ct)
    return false
  } catch {
    return true
  }
}

async function legacySha256(code: string): Promise<string> {
  return toHex(await sha256Bytes(code))
}

/** Hash used for NEW backup codes. */
export async function hashBackupCode(code: string): Promise<string> {
  const key = currentKey()
  if (!key) { warnOnce(); return legacySha256(code) }
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(key), enc.encode(code))
  return toHex(sig)
}

/** Every hash a presented code could be stored under (keyed first, then legacy). */
export async function backupCodeHashCandidates(code: string): Promise<string[]> {
  const out: string[] = []
  const key = currentKey()
  if (key) {
    out.push(toHex(await crypto.subtle.sign('HMAC', await hmacKey(key), enc.encode(code))))
  }
  const prev = previousKey()
  if (prev) {
    out.push(toHex(await crypto.subtle.sign('HMAC', await hmacKey(prev), enc.encode(code))))
  }
  out.push(await legacySha256(code))
  return out
}
