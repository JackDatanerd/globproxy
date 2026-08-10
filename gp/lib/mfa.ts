import * as OTPAuth from 'otpauth'
import QRCode from 'qrcode'
import { createAdminClient } from '@/lib/supabase/server'

type AdminClient = Awaited<ReturnType<typeof createAdminClient>>

const ISSUER = 'GlobProxy'
const MFA_SESSION_TTL_MS = 12 * 60 * 60 * 1000 // 12h — re-verify roughly once a working session
const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000
const BACKUP_CODE_COUNT = 10

export const MFA_COOKIE_NAME = 'gp_mfa'
export const MFA_COOKIE_MAX_AGE_S = Math.floor(MFA_SESSION_TTL_MS / 1000)

// ── small crypto helpers ──────────────────────────────────────────────
// Intentionally duplicated from lib/apiAuth.ts rather than shared —
// these are two independently security-sensitive surfaces (API-key auth
// vs. MFA), and a four-line hash helper isn't worth coupling their
// blast radius together for.
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function randomHexToken(bytes = 32): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Unambiguous alphabet — no 0/O/1/I/L — so a code copied off a printed
// sheet or read aloud doesn't get mistyped.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
function randomBackupCode(): string {
  const arr = new Uint8Array(8)
  crypto.getRandomValues(arr)
  const chars = Array.from(arr, b => CODE_ALPHABET[b % CODE_ALPHABET.length])
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}`
}

export function isBackupCodeFormat(code: string): boolean {
  return /^[A-Z2-9]{4}-[A-Z2-9]{4}$/i.test(code.trim())
}

export function mfaRequiredForRole(role: string | null | undefined): boolean {
  return role === 'admin' || role === 'reseller'
}

function buildTotp(email: string, base32Secret: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: ISSUER,
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(base32Secret),
  })
}

type FactorRow = {
  user_id: string
  secret: string
  confirmed: boolean
  failed_attempts: number
  locked_until: string | null
}

async function getFactor(supabase: AdminClient, userId: string): Promise<FactorRow | null> {
  const { data } = await supabase
    .from('mfa_totp_factors')
    .select('user_id, secret, confirmed, failed_attempts, locked_until')
    .eq('user_id', userId)
    .maybeSingle()
  return (data as FactorRow) ?? null
}

function isLocked(factor: FactorRow | null): boolean {
  return !!factor?.locked_until && new Date(factor.locked_until).getTime() > Date.now()
}

// Shared by every "check a code" path (confirm, verify, disable, rotate
// backup codes) so lockout behaves identically everywhere: 5 consecutive
// failures locks the factor for 15 minutes, full stop, regardless of
// which flow the failures came from. A code split across a TOTP-guess
// pass here and a backup-code-guess pass there still counts toward the
// same counter — there's no separate, smaller budget to bypass by
// switching code type mid-attack.
async function registerFailedAttempt(supabase: AdminClient, userId: string, factor: FactorRow): Promise<void> {
  const attempts = factor.failed_attempts + 1
  const locked = attempts >= MAX_FAILED_ATTEMPTS
  await supabase
    .from('mfa_totp_factors')
    .update({
      failed_attempts: locked ? 0 : attempts,
      locked_until: locked ? new Date(Date.now() + LOCKOUT_MS).toISOString() : factor.locked_until,
    })
    .eq('user_id', userId)
}

async function clearFailedAttempts(supabase: AdminClient, userId: string): Promise<void> {
  await supabase
    .from('mfa_totp_factors')
    .update({ failed_attempts: 0, locked_until: null, last_used_at: new Date().toISOString() })
    .eq('user_id', userId)
}

// ── Enrollment ────────────────────────────────────────────────────────
export interface EnrollmentStart {
  secret: string
  otpauth_uri: string
  qr_svg: string
}

// Idempotent while unconfirmed (re-running this before confirm just
// issues a fresh secret + QR — handles the "I scanned it into the wrong
// app, let me restart" case without leaving orphaned rows). Once
// confirmed=true, this refuses: an account with MFA already on must go
// through disableMfa() (which requires a valid code) before it can
// re-enroll, so a hijacked-but-not-yet-MFA'd session can't silently
// swap in a new secret on top of a factor the real owner already set up.
export async function startEnrollment(userId: string, email: string): Promise<EnrollmentStart> {
  const supabase = await createAdminClient()

  const existing = await getFactor(supabase, userId)
  if (existing?.confirmed) {
    throw new Error('Two-factor authentication is already enabled on this account. Disable it before setting up again.')
  }

  const secret = new OTPAuth.Secret({ size: 20 })
  const totp = buildTotp(email, secret.base32)

  const { error } = await supabase.from('mfa_totp_factors').upsert(
    {
      user_id: userId,
      secret: secret.base32,
      confirmed: false,
      failed_attempts: 0,
      locked_until: null,
    },
    { onConflict: 'user_id' }
  )
  if (error) throw new Error('Could not start MFA setup. Please try again.')

  const otpauthUri = totp.toString()
  const qrSvg = await QRCode.toString(otpauthUri, { type: 'svg', width: 220, margin: 1 })

  return { secret: secret.base32, otpauth_uri: otpauthUri, qr_svg: qrSvg }
}

export interface ConfirmResult {
  backup_codes: string[]
  session_token: string
}

export async function confirmEnrollment(userId: string, email: string, code: string): Promise<ConfirmResult> {
  const supabase = await createAdminClient()
  const factor = await getFactor(supabase, userId)
  if (!factor) throw new Error('No pending MFA setup found — start setup again.')
  if (factor.confirmed) throw new Error('Two-factor authentication is already enabled on this account.')
  if (isLocked(factor)) throw new Error('Too many incorrect attempts. Try again in a few minutes.')

  const totp = buildTotp(email, factor.secret)
  const delta = totp.validate({ token: code.trim(), window: 1 })
  if (delta === null) {
    await registerFailedAttempt(supabase, userId, factor)
    throw new Error('Incorrect code. Check your authenticator app and try again.')
  }

  await supabase
    .from('mfa_totp_factors')
    .update({
      confirmed: true,
      confirmed_at: new Date().toISOString(),
      failed_attempts: 0,
      locked_until: null,
      last_used_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
  await supabase.from('profiles').update({ mfa_enabled: true }).eq('id', userId)

  const backupCodes = await regenerateBackupCodesInternal(supabase, userId)
  const sessionToken = await createVerifiedSession(supabase, userId)

  return { backup_codes: backupCodes, session_token: sessionToken }
}

// ── Step-up verification (login / re-verify) ────────────────────────────
export interface VerifyResult {
  session_token: string
  used_backup_code: boolean
  backup_codes_remaining?: number
}

export async function verifyFactor(userId: string, email: string, code: string): Promise<VerifyResult> {
  const supabase = await createAdminClient()
  const factor = await getFactor(supabase, userId)
  if (!factor?.confirmed) throw new Error('Two-factor authentication is not set up on this account.')
  if (isLocked(factor)) throw new Error('Too many incorrect attempts. Try again in a few minutes.')

  const trimmed = code.trim()
  const usedBackupCode = isBackupCodeFormat(trimmed)
  const ok = usedBackupCode
    ? await consumeBackupCode(supabase, userId, trimmed)
    : buildTotp(email, factor.secret).validate({ token: trimmed, window: 1 }) !== null

  if (!ok) {
    await registerFailedAttempt(supabase, userId, factor)
    throw new Error(usedBackupCode ? 'That backup code is invalid or has already been used.' : 'Incorrect code. Try again.')
  }

  await clearFailedAttempts(supabase, userId)
  const sessionToken = await createVerifiedSession(supabase, userId)

  const result: VerifyResult = { session_token: sessionToken, used_backup_code: usedBackupCode }
  if (usedBackupCode) {
    result.backup_codes_remaining = await countRemainingBackupCodes(userId, supabase)
  }
  return result
}

// ── Backup codes ──────────────────────────────────────────────────────
// Deletes any still-unused codes from a previous batch before minting a
// fresh set — a rotate/regenerate always fully replaces the outstanding
// set rather than appending to it, so a user is never holding a mix of
// "these are current" and "these are stale" codes with no way to tell
// which is which.
async function regenerateBackupCodesInternal(supabase: AdminClient, userId: string): Promise<string[]> {
  await supabase.from('mfa_backup_codes').delete().eq('user_id', userId).is('used_at', null)

  const codes: string[] = []
  const rows: { user_id: string; code_hash: string }[] = []
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const code = randomBackupCode()
    codes.push(code)
    rows.push({ user_id: userId, code_hash: await sha256Hex(code) })
  }
  const { error } = await supabase.from('mfa_backup_codes').insert(rows)
  if (error) throw new Error('Could not generate backup codes. Please try again.')
  return codes
}

// Requires a fresh valid TOTP code — same bar as disabling MFA entirely —
// since a full replacement set invalidates every code the user currently
// holds, including ones they might still need.
export async function regenerateBackupCodes(userId: string, email: string, code: string): Promise<string[]> {
  const supabase = await createAdminClient()
  const factor = await getFactor(supabase, userId)
  if (!factor?.confirmed) throw new Error('Two-factor authentication is not set up on this account.')
  if (isLocked(factor)) throw new Error('Too many incorrect attempts. Try again in a few minutes.')

  const ok = buildTotp(email, factor.secret).validate({ token: code.trim(), window: 1 }) !== null
  if (!ok) {
    await registerFailedAttempt(supabase, userId, factor)
    throw new Error('Incorrect code.')
  }
  await clearFailedAttempts(supabase, userId)
  return regenerateBackupCodesInternal(supabase, userId)
}

async function consumeBackupCode(supabase: AdminClient, userId: string, code: string): Promise<boolean> {
  const hash = await sha256Hex(code.trim().toUpperCase())
  const { data } = await supabase
    .from('mfa_backup_codes')
    .select('id')
    .eq('user_id', userId)
    .eq('code_hash', hash)
    .is('used_at', null)
    .maybeSingle()
  if (!data) return false

  // Re-check is_null in the UPDATE itself (not just the SELECT above) so
  // two concurrent requests racing to redeem the exact same code can't
  // both succeed — only the update that actually flips used_at from null
  // wins, the loser's .select() comes back empty.
  const { data: updated } = await supabase
    .from('mfa_backup_codes')
    .update({ used_at: new Date().toISOString() })
    .eq('id', data.id)
    .is('used_at', null)
    .select('id')
    .maybeSingle()
  return !!updated
}

export async function countRemainingBackupCodes(userId: string, supabase?: AdminClient): Promise<number> {
  const client = supabase ?? (await createAdminClient())
  const { count } = await client
    .from('mfa_backup_codes')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .is('used_at', null)
  return count ?? 0
}

// ── Verified sessions (custom step-up cookie) ────────────────────────────
// Supabase's own session cookie has no idea our TOTP step-up happened —
// this is a second, independent short-lived proof, checked by
// middleware.ts on every protected request for admin/reseller accounts.
// Opaque random token in the cookie, only its SHA-256 hash stored server
// side — identical shape to how api_keys (migration 0005) handles bearer
// tokens, so a leaked cookie value alone can't be reverse-matched against
// the DB.
async function createVerifiedSession(supabase: AdminClient, userId: string): Promise<string> {
  const token = randomHexToken()
  const tokenHash = await sha256Hex(token)
  const expiresAt = new Date(Date.now() + MFA_SESSION_TTL_MS).toISOString()
  const { error } = await supabase
    .from('mfa_verified_sessions')
    .insert({ token_hash: tokenHash, user_id: userId, expires_at: expiresAt })
  if (error) throw new Error('Could not complete verification. Please try again.')
  return token
}

export async function checkVerifiedSession(token: string | undefined, userId: string): Promise<boolean> {
  if (!token) return false
  const supabase = await createAdminClient()
  const tokenHash = await sha256Hex(token)
  const { data } = await supabase
    .from('mfa_verified_sessions')
    .select('user_id, expires_at')
    .eq('token_hash', tokenHash)
    .maybeSingle()
  if (!data || data.user_id !== userId) return false
  return new Date(data.expires_at).getTime() > Date.now()
}

export async function revokeVerifiedSession(token: string | undefined): Promise<void> {
  if (!token) return
  const supabase = await createAdminClient()
  const tokenHash = await sha256Hex(token)
  await supabase.from('mfa_verified_sessions').delete().eq('token_hash', tokenHash)
}

async function revokeAllVerifiedSessions(supabase: AdminClient, userId: string): Promise<void> {
  await supabase.from('mfa_verified_sessions').delete().eq('user_id', userId)
}

// ── Disable / reset ──────────────────────────────────────────────────
// Self-service disable requires proof of a currently-valid code (TOTP or
// backup) — the same bar as any other MFA action, so a hijacked
// already-authenticated browser session can't unilaterally turn MFA off
// without also possessing the second factor. Note: for admin/reseller
// accounts this doesn't actually get them out from under the requirement
// — the very next protected request re-enrolls them via the mandatory
// setup gate in middleware.ts. This exists for legitimate device-reset
// scenarios (switching authenticator apps, etc.), not as an opt-out.
export async function disableMfa(userId: string, email: string, code: string): Promise<void> {
  const supabase = await createAdminClient()
  const factor = await getFactor(supabase, userId)
  if (!factor?.confirmed) throw new Error('Two-factor authentication is not currently enabled.')
  if (isLocked(factor)) throw new Error('Too many incorrect attempts. Try again in a few minutes.')

  const trimmed = code.trim()
  const ok = isBackupCodeFormat(trimmed)
    ? await consumeBackupCode(supabase, userId, trimmed)
    : buildTotp(email, factor.secret).validate({ token: trimmed, window: 1 }) !== null

  if (!ok) {
    await registerFailedAttempt(supabase, userId, factor)
    throw new Error('Incorrect code.')
  }

  await wipeMfa(supabase, userId)
}

// Support-desk recovery path: a user who lost both their authenticator
// and every backup code has no self-service way back in by design (that's
// what makes backup codes meaningful). An admin with out-of-band identity
// verification is the intended escape hatch — see
// app/api/admin/mfa-reset/route.ts. This performs the same full wipe as
// self-service disable, just without requiring a code, since the caller
// has already been authorized at the route level (admin role check).
export async function adminResetMfa(userId: string): Promise<void> {
  const supabase = await createAdminClient()
  await wipeMfa(supabase, userId)
}

async function wipeMfa(supabase: AdminClient, userId: string): Promise<void> {
  await supabase.from('mfa_totp_factors').delete().eq('user_id', userId)
  await supabase.from('mfa_backup_codes').delete().eq('user_id', userId)
  await revokeAllVerifiedSessions(supabase, userId)
  await supabase.from('profiles').update({ mfa_enabled: false }).eq('id', userId)
}
