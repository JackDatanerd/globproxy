import * as OTPAuth from 'otpauth'
import { renderQrSvg } from '@/lib/qrSvg'
import { createAdminClient } from '@/lib/supabase/server'
import {
  encryptSecret, decryptSecret, secretNeedsRewrite, MfaConfigError,
  hashBackupCode, backupCodeHashCandidates,
} from '@/lib/mfaCrypto'
import { recordAndNotify, sendBackupCodesLowNotice, logSecurityEvent } from '@/lib/securityEvents'
import { NextResponse } from 'next/server'

type AdminClient = Awaited<ReturnType<typeof createAdminClient>>

const ISSUER = 'GlobProxy'
const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_S = 15 * 60
const BACKUP_CODE_COUNT = 10

// How long a completed second-factor check keeps a browser "verified".
//  - default: 12h, roughly one working session
//  - "trust this browser": 30 days — never offered to admin accounts
export const MFA_SESSION_TTL_MS = 12 * 60 * 60 * 1000
export const MFA_REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000

export const MFA_COOKIE_NAME = 'gp_mfa'
export const MFA_COOKIE_MAX_AGE_S = Math.floor(MFA_SESSION_TTL_MS / 1000)

// ── small crypto helpers ──────────────────────────────────────────────
// Intentionally independent of lib/apiAuth.ts — two separately
// security-sensitive surfaces, not worth coupling.
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
  // Rejection sampling so every character is uniform (256 % 31 != 0).
  const limit = 256 - (256 % CODE_ALPHABET.length)
  const chars: string[] = []
  while (chars.length < 8) {
    const buf = new Uint8Array(16)
    crypto.getRandomValues(buf)
    for (const b of buf) {
      if (b < limit && chars.length < 8) chars.push(CODE_ALPHABET[b % CODE_ALPHABET.length])
    }
  }
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}`
}

// ── code parsing ──────────────────────────────────────────────────────
// Accepts what people actually type/paste: "123 456", "123-456",
// "abcd-2345", "ABCD2345", " abcd 2345 ". Anything that is neither a 6-digit
// TOTP nor an 8-char backup code is rejected BEFORE it touches the attempt
// budget — a malformed paste must not count toward a lockout.
export type ParsedMfaCode = { kind: 'totp' | 'backup'; code: string }

export function parseMfaCode(raw: string): ParsedMfaCode | null {
  const compact = raw.replace(/[\s-]/g, '').toUpperCase()
  if (/^\d{6}$/.test(compact)) return { kind: 'totp', code: compact }
  if (/^[A-Z2-9]{8}$/.test(compact)) return { kind: 'backup', code: `${compact.slice(0, 4)}-${compact.slice(4)}` }
  return null
}

export function isBackupCodeFormat(code: string): boolean {
  return parseMfaCode(code)?.kind === 'backup'
}

const BAD_FORMAT_MSG = 'Enter the 6-digit code from your authenticator app, or a backup code (XXXX-XXXX).'

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
  last_used_counter: number | null
  created_at: string | null
}

async function getFactor(supabase: AdminClient, userId: string): Promise<FactorRow | null> {
  const { data, error } = await supabase
    .from('mfa_totp_factors')
    .select('user_id, secret, confirmed, failed_attempts, locked_until, last_used_counter, created_at')
    .eq('user_id', userId)
    .maybeSingle()
  // A query failure must not be indistinguishable from "this user has no
  // factor": every caller treats null as "not set up". Throwing makes an
  // infra failure loud — check server logs for the real `error`.
  if (error) {
    console.error('[mfa] getFactor query failed — NOT the same as "not set up"', userId, error)
    throw new Error('Could not verify your account right now. Please try again in a moment.')
  }
  return (data as FactorRow) ?? null
}

const TOTP_PERIOD_S = 30

function currentPeriodCounter(): number {
  return Math.floor(Date.now() / 1000 / TOTP_PERIOD_S)
}

// Returns the absolute period counter the code belongs to (window ±1), or
// null if the code is wrong. One-time use is NOT decided here — that is an
// atomic compare-and-set in the database (mfa_consume_totp), because a
// read-then-write check let two concurrent submissions of the same code
// both succeed.
async function matchTotpCounter(factor: FactorRow, email: string, code: string): Promise<number | null> {
  const secret = await decryptSecret(factor.secret, factor.user_id)
  const delta = buildTotp(email, secret).validate({ token: code, window: 1 })
  if (delta === null) return null
  return currentPeriodCounter() + delta
}

// ── Attempt budget (atomic) ───────────────────────────────────────────
// Every "check a code" path (confirm, verify, disable, rotate backup codes,
// change password / email step-up) first RESERVES one slot in the shared
// budget via mfa_begin_attempt, in a single row-locked SQL function, and
// only then looks at the code. Reserving before checking is what makes the
// limit hold under parallel requests: N simultaneous guesses used to all
// read failed_attempts = 0 and all write 1, so the lock never tripped.
// 5 slots per window; the 5th reservation locks the factor for 15 minutes
// unless that very attempt succeeds. A success resets the budget.
type AttemptGate = 'ok' | 'ok_last'

// The lock is per account, so someone who only knows the password could keep
// the owner locked out. A password reset by email (which proves mailbox
// control AND replaces the password they hold) lifts it — say so.
const LOCKED_MSG = 'Too many incorrect attempts. Try again in 15 minutes, or reset your password by email to unlock sooner.'

async function beginAttempt(supabase: AdminClient, userId: string): Promise<AttemptGate> {
  const { data, error } = await supabase.rpc('mfa_begin_attempt', {
    p_user_id: userId,
    p_max: MAX_FAILED_ATTEMPTS,
    p_lock_seconds: LOCKOUT_S,
  })
  if (error) {
    console.error('[mfa] mfa_begin_attempt failed', userId, error)
    throw new Error('Could not verify your account right now. Please try again in a moment.')
  }
  if (data === 'locked') throw new Error(LOCKED_MSG)
  if (data === 'missing') throw new Error('Two-factor authentication is not set up on this account.')
  return data === 'ok_last' ? 'ok_last' : 'ok'
}

// `gate` matters: the 5th reservation already set the lock, so an
// infrastructure error on THAT attempt must lift the lock again too.
async function refundAttempt(supabase: AdminClient, userId: string, gate: AttemptGate = 'ok'): Promise<void> {
  await supabase
    .rpc('mfa_refund_attempt', { p_user_id: userId, p_was_last: gate === 'ok_last', p_max: MAX_FAILED_ATTEMPTS })
    .then(() => {}, () => {})
}

/**
 * Message safe to show an end user. Operator-side problems (missing or wrong
 * encryption key) are logged and replaced by a generic line; everything else
 * thrown by this module is already written for end users.
 */
export function publicMfaError(e: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (e instanceof MfaConfigError) {
    console.error('[mfa] configuration error', e.message)
    return 'Two-factor verification is temporarily unavailable. Please try again shortly.'
  }
  return e instanceof Error && e.message ? e.message : fallback
}

class WrongCode extends Error {}

// Shared by every flow. Returns which kind of code was accepted.
async function checkCode(
  supabase: AdminClient,
  userId: string,
  email: string,
  factor: FactorRow,
  rawCode: string,
  wrongMsg: { totp: string; backup: string },
  ctx?: { req?: Request },
): Promise<'totp' | 'backup'> {
  const parsed = parseMfaCode(rawCode)
  if (!parsed) throw new Error(BAD_FORMAT_MSG)

  const gate = await beginAttempt(supabase, userId)
  let replayed = false
  try {
    let ok = false
    if (parsed.kind === 'backup') {
      ok = await consumeBackupCode(supabase, userId, parsed.code)
      if (ok) {
        // The 5th reservation locks the factor up front and only a success lifts it. The code is
        // already spent, so a failure here must not throw (that would refund and report an error
        // for a code that cannot be replayed) — but the lock must not outlive a correct sign-in.
        const { error: clearErr } = await supabase.rpc('mfa_clear_failures', { p_user_id: userId })
        if (clearErr) {
          console.error('[mfa] mfa_clear_failures failed after an accepted backup code — lifting the lock instead', userId, clearErr.message)
          await refundAttempt(supabase, userId, gate)
        }
        await logSecurityEvent({ userId, event: 'mfa_backup_code_used', req: ctx?.req, admin: supabase })
      }
    } else {
      const counter = await matchTotpCounter(factor, email, parsed.code)
      if (counter !== null) {
        ok = await consumeTotp(supabase, userId, counter)
        // A correct code that was already accepted (same 30-second step):
        // say so instead of "incorrect", so a user who submits the same code
        // twice (login, then a step-up) knows to wait for the next one.
        replayed = !ok
      }
      if (ok && (await secretNeedsRewrite(factor.secret, userId))) {
        // Lazy upgrade: legacy plaintext, or encrypted under the previous
        // key, is rewritten under the current key.
        // Best-effort: the code is ALREADY consumed at this point, so a failure
        // here must not surface as an error (it would refund the attempt and
        // tell the user to retry a code that can no longer be replayed).
        try {
          const plain = await decryptSecret(factor.secret, userId)
          // Compare-and-set on the value that was just verified: if the secret changed in the
          // meantime (a "Change authenticator" confirm, or disable + re-enrol, in another
          // request) this matches no row, instead of overwriting the NEW secret with a
          // re-encrypted copy of the old one and locking the owner out of their new app.
          const { error: rwErr } = await supabase.from('mfa_totp_factors')
            .update({ secret: await encryptSecret(plain, userId) })
            .eq('user_id', userId)
            .eq('secret', factor.secret)
          if (rwErr) console.error('[mfa] secret rewrite failed', userId, rwErr.message)
        } catch (rwEx) {
          console.error('[mfa] secret rewrite threw', userId, rwEx)
        }
      }
    }
    if (!ok) throw new WrongCode()
    return parsed.kind
  } catch (e) {
    if (e instanceof WrongCode) {
      if (replayed) {
        // A CORRECT code that was already spent in this 30-second step (sign in,
        // then straight into a step-up with the same code) is not a wrong guess:
        // give the slot back so it can't walk the owner into a lockout, and don't
        // log it as a failure. It still can't succeed — the counter is spent.
        await refundAttempt(supabase, userId, gate)
        throw new Error('That code was already used. Wait for the next one to appear in your authenticator and try again.')
      }
      await logSecurityEvent({ userId, event: 'mfa_failed', req: ctx?.req, admin: supabase, meta: { kind: parsed.kind } })
      if (gate === 'ok_last') await announceLockout(supabase, userId, ctx?.req)
      throw new Error(parsed.kind === 'backup' ? wrongMsg.backup : wrongMsg.totp)
    }
    // Infrastructure failure, not the user's fault — don't let it eat budget.
    await refundAttempt(supabase, userId, gate)
    throw e
  }
}

async function announceLockout(supabase: AdminClient, userId: string, req?: Request) {
  // Durable: stored with notify = true, sent now, retried by the cron sweep if the provider is down.
  await recordAndNotify({ userId, event: 'mfa_locked', req, admin: supabase })
}

async function consumeTotp(supabase: AdminClient, userId: string, counter: number): Promise<boolean> {
  const { data, error } = await supabase.rpc('mfa_consume_totp', { p_user_id: userId, p_counter: counter })
  if (error) {
    console.error('[mfa] mfa_consume_totp failed', userId, error)
    throw new Error('Could not verify your account right now. Please try again in a moment.')
  }
  return data === true
}

// ── Enrollment ────────────────────────────────────────────────────────
export interface EnrollmentStart {
  secret: string
  otpauth_uri: string
  qr_svg: string
}

// Idempotent while unconfirmed: re-opening setup within ENROLL_REUSE_MS
// returns the SAME secret/QR (a second tab or a refresh must not invalidate
// the QR code someone is mid-way through scanning); after that window a new
// secret is issued. Once confirmed, this refuses: an account with MFA already
// on must go through disableMfa() (which requires a valid code) before it can
// re-enroll. The write is a single conditional upsert in SQL
// (mfa_start_enrollment) that refuses to touch a confirmed factor, so a
// concurrent confirm in another tab can't be silently un-confirmed. It
// deliberately does NOT touch failed_attempts / locked_until — restarting
// setup must not reset a lock.
const ENROLL_REUSE_MS = 15 * 60 * 1000
const ALREADY_ENABLED_MSG = 'Two-factor authentication is already enabled on this account. Disable it before setting up again.'

export async function startEnrollment(userId: string, email: string): Promise<EnrollmentStart> {
  const supabase = await createAdminClient()

  const existing = await getFactor(supabase, userId)
  if (existing?.confirmed) throw new Error(ALREADY_ENABLED_MSG)

  if (existing && existing.created_at && Date.now() - new Date(existing.created_at).getTime() < ENROLL_REUSE_MS) {
    try {
      const secret = await decryptSecret(existing.secret, userId)
      const uri = buildTotp(email, secret).toString()
      return { secret, otpauth_uri: uri, qr_svg: renderQrSvg(uri, { width: 220, margin: 1 }) }
    } catch (e) {
      if (!(e instanceof MfaConfigError)) throw e
      // Undecryptable pending secret: fall through and issue a fresh one.
    }
  }

  const secret = new OTPAuth.Secret({ size: 20 })
  const totp = buildTotp(email, secret.base32)

  const { data: started, error } = await supabase.rpc('mfa_start_enrollment', {
    p_user_id: userId,
    p_secret: await encryptSecret(secret.base32, userId),
  })
  if (error) throw new Error('Could not start MFA setup. Please try again.')
  if (started !== true) throw new Error(ALREADY_ENABLED_MSG)

  const otpauthUri = totp.toString()
  const qrSvg = renderQrSvg(otpauthUri, { width: 220, margin: 1 })

  return { secret: secret.base32, otpauth_uri: otpauthUri, qr_svg: qrSvg }
}

export interface ConfirmResult {
  backup_codes: string[]
  session_token: string
  session_ttl_s: number
}

export async function confirmEnrollment(userId: string, email: string, code: string, req?: Request, authSessionId?: string | null): Promise<ConfirmResult> {
  const supabase = await createAdminClient()
  const factor = await getFactor(supabase, userId)
  if (!factor) throw new Error('No pending MFA setup found — start setup again.')
  if (factor.confirmed) throw new Error('Two-factor authentication is already enabled on this account.')

  // Enrollment is TOTP-only (there are no backup codes yet).
  const parsed = parseMfaCode(code)
  if (!parsed || parsed.kind !== 'totp') throw new Error('Enter the 6-digit code from your authenticator app.')

  const gate = await beginAttempt(supabase, userId)
  let usedCounter: number | null
  try {
    usedCounter = await matchTotpCounter(factor, email, parsed.code)
  } catch (e) {
    await refundAttempt(supabase, userId, gate)
    throw e
  }
  if (usedCounter === null) {
    if (gate === 'ok_last') await announceLockout(supabase, userId, req)
    throw new Error('Incorrect code. Check your authenticator app and try again.')
  }

  // ONE transaction (migrations 0045 / 0053): the factor flips to confirmed,
  // profiles.mfa_enabled flips, and the first backup-code set is stored —
  // together or not at all. Previously the codes were written afterwards, so
  // a failure in between left an enrolled account that never saw its codes.
  // The function also refuses an already-confirmed factor (double-confirm race).
  const { codes, hashes } = await newBackupCodeSet()
  const { error: confirmErr } = await supabase.rpc('confirm_totp_enrollment_atomic', {
    p_user_id: userId,
    p_used_counter: usedCounter,
    p_hashes: hashes,
    // CAS: only confirm the exact pending seed the submitted code was verified against.
    p_expected_secret: factor.secret,
  })
  if (confirmErr) {
    await refundAttempt(supabase, userId, gate)
    if (confirmErr.code === 'P0001') throw new Error('Two-factor authentication is already enabled on this account.')
    if (confirmErr.code === 'P0002') throw new Error('No pending MFA setup found — start setup again.')
    console.error('[mfa] confirm_totp_enrollment_atomic failed', userId, confirmErr)
    throw new Error('Could not confirm MFA setup. Please try again.')
  }

  // Enrollment is committed. If minting the verified-browser token fails the
  // user must STILL receive their backup codes (they're shown exactly once);
  // they simply verify once on the next page.
  try {
    const { token, ttlS } = await createVerifiedSession(supabase, userId, MFA_SESSION_TTL_MS, { req, authSessionId })
    return { backup_codes: codes, session_token: token, session_ttl_s: ttlS }
  } catch (e) {
    console.error('[mfa] enrollment committed but verified session could not be created', userId, e)
    return { backup_codes: codes, session_token: '', session_ttl_s: 0 }
  }
}

// ── Step-up verification (login / re-verify) ────────────────────────────
export interface VerifyResult {
  session_token: string
  session_ttl_s: number
  used_backup_code: boolean
  backup_codes_remaining?: number
}

// ── Change authenticator (in place) ──────────────────────────────────
// Moving to a new phone used to mean disableMfa() then startEnrollment(): an account with no
// second factor in between, and a "2FA disabled" alert for a routine action. Here the account
// stays protected throughout: the person proves the CURRENT factor (an authenticator code, or a
// backup code when the old phone is gone), a NEW seed is parked beside the live one
// (migration 0082: pending_secret), and it replaces the live secret only when a code from the new
// authenticator has been proven — one atomic UPDATE (mfa_rekey_confirm). Backup codes are
// unchanged. Every other trusted browser then loses its 2FA trust (the old authenticator may be
// the reason for the change — a lost or stolen phone).
const REKEY_WINDOW_MS = 15 * 60 * 1000
const REKEY_UNAVAILABLE_MSG = 'Changing the authenticator is temporarily unavailable. Please try again shortly.'
const REKEY_NONE_MSG = 'No authenticator change is in progress, or it timed out. Start again.'
const NOT_ENROLLED_MSG = 'Two-factor authentication is not set up on this account.'

export async function startRekey(userId: string, email: string, code: string, req?: Request): Promise<EnrollmentStart> {
  const supabase = await createAdminClient()
  const factor = await getFactor(supabase, userId)
  if (!factor?.confirmed) throw new Error(NOT_ENROLLED_MSG)

  await checkCode(supabase, userId, email, factor, code, {
    totp: 'Incorrect code. Enter the current code from your existing authenticator, or a backup code.',
    backup: 'That backup code is invalid or has already been used.',
  }, { req })

  const secret = new OTPAuth.Secret({ size: 20 })
  const { data: started, error } = await supabase.rpc('mfa_rekey_start', {
    p_user_id: userId,
    p_secret: await encryptSecret(secret.base32, userId),
  })
  if (error) {
    // Most likely migration 0082 is not applied yet.
    console.error('[mfa] mfa_rekey_start failed', userId, error)
    throw new Error(REKEY_UNAVAILABLE_MSG)
  }
  if (started !== true) throw new Error(NOT_ENROLLED_MSG)

  const uri = buildTotp(email, secret.base32).toString()
  return { secret: secret.base32, otpauth_uri: uri, qr_svg: renderQrSvg(uri, { width: 220, margin: 1 }) }
}

export async function confirmRekey(userId: string, email: string, code: string, req?: Request, keepToken?: string): Promise<void> {
  const parsed = parseMfaCode(code)
  if (!parsed || parsed.kind !== 'totp') throw new Error('Enter the 6-digit code from your NEW authenticator app.')

  const supabase = await createAdminClient()
  const factor = await getFactor(supabase, userId)
  if (!factor?.confirmed) throw new Error(NOT_ENROLLED_MSG)

  const { data: pend, error: pendErr } = await supabase
    .from('mfa_totp_factors').select('pending_secret, pending_created_at').eq('user_id', userId).maybeSingle()
  if (pendErr) {
    console.error('[mfa] reading pending authenticator failed', userId, pendErr)
    throw new Error(REKEY_UNAVAILABLE_MSG)
  }
  const pendingSecret = (pend as { pending_secret: string | null } | null)?.pending_secret
  const pendingAt = (pend as { pending_created_at: string | null } | null)?.pending_created_at
  if (!pendingSecret || !pendingAt || Date.now() - new Date(pendingAt).getTime() > REKEY_WINDOW_MS) throw new Error(REKEY_NONE_MSG)

  const gate = await beginAttempt(supabase, userId)
  let counter: number | null
  try {
    counter = await matchTotpCounter({ ...factor, secret: pendingSecret }, email, parsed.code)
  } catch (e) {
    await refundAttempt(supabase, userId, gate)
    throw e
  }
  if (counter === null) {
    if (gate === 'ok_last') await announceLockout(supabase, userId, req)
    throw new Error('Incorrect code. Check the NEW authenticator app and try again.')
  }

  const { data: swapped, error } = await supabase.rpc('mfa_rekey_confirm', {
    p_user_id: userId,
    p_counter: counter,
    p_max_age: '15 minutes',
    // CAS: only swap in the exact pending seed the submitted code was verified against.
    p_expected_pending: pendingSecret,
  })
  if (error) {
    await refundAttempt(supabase, userId, gate)
    console.error('[mfa] mfa_rekey_confirm failed', userId, error)
    throw new Error('Could not switch authenticator. Please try again.')
  }
  if (swapped !== true) {
    await refundAttempt(supabase, userId, gate)
    throw new Error(REKEY_NONE_MSG)
  }
  await revokeOtherVerifiedSessions(userId, keepToken)
}

export async function verifyFactor(
  userId: string,
  email: string,
  code: string,
  opts: { remember?: boolean; req?: Request; authSessionId?: string | null } = {},
): Promise<VerifyResult> {
  const supabase = await createAdminClient()
  const factor = await getFactor(supabase, userId)
  if (!factor?.confirmed) throw new Error('Two-factor authentication is not set up on this account.')

  const kind = await checkCode(supabase, userId, email, factor, code, {
    totp: 'Incorrect code. Try again.',
    backup: 'That backup code is invalid or has already been used.',
  }, { req: opts.req })

  // "Trust this browser" is never offered to admin accounts. Fails CLOSED: if
  // the role can't be read, the short session is used, never the 30-day one.
  let ttl = MFA_SESSION_TTL_MS
  if (opts.remember) {
    const { data: profile, error: roleErr } = await supabase.from('profiles').select('role').eq('id', userId).maybeSingle()
    if (roleErr) console.error('[mfa] role lookup failed; not granting a remembered session', userId, roleErr.message)
    else if (profile && profile.role !== 'admin') ttl = MFA_REMEMBER_TTL_MS
  }

  const remembered = ttl === MFA_REMEMBER_TTL_MS
  const { token, ttlS } = await createVerifiedSessionAfterConsume(supabase, userId, ttl, { req: opts.req, remembered, authSessionId: opts.authSessionId })
  if (remembered) await logSecurityEvent({ userId, event: 'mfa_browser_trusted', req: opts.req, admin: supabase })

  await logSecurityEvent({ userId, event: 'mfa_verified', req: opts.req, admin: supabase, meta: { kind, remembered } })
  // Proof the real owner still holds the authenticator: any 2FA-removal
  // request that was started in the meantime is no longer needed.
  await cancelOpenRecoveryRequests(supabase, userId, opts.req, 'sign_in')

  const result: VerifyResult = { session_token: token, session_ttl_s: ttlS, used_backup_code: kind === 'backup' }
  if (kind === 'backup') {
    // Best-effort: the code is already spent and the session created, so a DB
    // hiccup while counting what is left must not turn a successful sign-in
    // into a 400 with no cookie (the user would lose a code AND not get in).
    let remaining: number | null = null
    try {
      remaining = await countRemainingBackupCodes(userId, supabase)
    } catch (e) {
      console.error('[mfa] could not count remaining backup codes after a successful verify', e)
    }
    if (remaining !== null) result.backup_codes_remaining = remaining
    if (remaining !== null && remaining <= 2) {
      try {
        const { data: profile } = await supabase.from('profiles').select('email, full_name').eq('id', userId).maybeSingle()
        if (profile?.email && profile.email !== '[deleted]') await sendBackupCodesLowNotice(profile.email, profile.full_name, remaining)
      } catch (e) {
        console.error('[mfa] low backup code notice failed', e)
      }
    }
  }
  return result
}

// The code is already CONSUMED when this runs (a TOTP step can't be replayed, a
// backup code is spent), so a transient failure here must not simply surface as
// "error, retry": the user's retry with the same code would be refused. Retry
// the write a few times first; if it still fails, say what happened.
async function createVerifiedSessionAfterConsume(
  supabase: AdminClient,
  userId: string,
  ttlMs: number,
  opts: { req?: Request; remembered?: boolean; authSessionId?: string | null },
) {
  let lastErr: unknown
  for (let i = 0; i < 3; i++) {
    try {
      return await createVerifiedSession(supabase, userId, ttlMs, opts)
    } catch (e) {
      lastErr = e
      if (i < 2) await new Promise(r => setTimeout(r, 250 * (i + 1)))
    }
  }
  console.error('[mfa] code accepted but verified session could not be created', userId, lastErr)
  throw new Error('Your code was accepted but we could not finish signing you in. Wait for the next code in your authenticator (or use a backup code) and try again.')
}

/**
 * A FRESH proof of the authenticator for a sensitive action (POST
 * /api/auth/reauth with { code }). Same attempt budget and one-time-use rules
 * as every other code check; it does not create or extend a verified-browser
 * session. The caller sets the short-lived step-up cookie (lib/reauth.ts).
 */
export async function verifyFreshCode(userId: string, email: string, code: string, req?: Request): Promise<'totp' | 'backup'> {
  const supabase = await createAdminClient()
  const factor = await getFactor(supabase, userId)
  if (!factor?.confirmed) throw new Error('Two-factor authentication is not set up on this account.')
  const kind = await checkCode(supabase, userId, email, factor, code, {
    totp: 'Incorrect code. Try again.',
    backup: 'That backup code is invalid or has already been used.',
  }, { req })
  await logSecurityEvent({ userId, event: 'mfa_verified', req, admin: supabase, meta: { kind, purpose: 'step_up' }, notify: false })
  return kind
}

/**
 * Cancels every still-open 2FA recovery request for the user. Called when the
 * owner proves they hold the authenticator (successful sign-in code), and
 * available to the signed-in cancel button. Returns how many were cancelled.
 */
export async function cancelOpenRecoveryRequests(supabase: AdminClient, userId: string, req?: Request, reason = 'owner'): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('mfa_recovery_requests')
      .update({ cancelled_at: new Date().toISOString() })
      .eq('user_id', userId)
      .is('completed_at', null)
      .is('cancelled_at', null)
      .select('id')
    if (error) { console.error('[mfa] cancelOpenRecoveryRequests failed', error.message); return 0 }
    const n = data?.length ?? 0
    if (n > 0) await logSecurityEvent({ userId, event: 'mfa_recovery_cancelled', req, admin: supabase, meta: { reason }, notify: false })
    return n
  } catch (e) {
    console.error('[mfa] cancelOpenRecoveryRequests threw', e)
    return 0
  }
}

// ── Backup codes ──────────────────────────────────────────────────────
// A rotate/regenerate always fully replaces the outstanding set — in ONE
// SQL transaction (mfa_replace_backup_codes). The old delete-then-insert pair
// left the user with zero codes if the insert failed.
async function newBackupCodeSet(): Promise<{ codes: string[]; hashes: string[] }> {
  const codes: string[] = []
  const hashes: string[] = []
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const code = randomBackupCode()
    codes.push(code)
    hashes.push(await hashBackupCode(code))
  }
  return { codes, hashes }
}

async function regenerateBackupCodesInternal(supabase: AdminClient, userId: string): Promise<string[]> {
  const { codes, hashes } = await newBackupCodeSet()
  const { error } = await supabase.rpc('mfa_replace_backup_codes', { p_user_id: userId, p_hashes: hashes })
  if (error) {
    console.error('[mfa] mfa_replace_backup_codes failed', userId, error)
    throw new Error('Could not generate backup codes. Please try again.')
  }
  return codes
}

// Requires a fresh valid code (TOTP or backup) — a full replacement set
// invalidates every code the user currently holds.
export async function regenerateBackupCodes(userId: string, email: string, code: string, req?: Request): Promise<string[]> {
  const supabase = await createAdminClient()
  const factor = await getFactor(supabase, userId)
  if (!factor?.confirmed) throw new Error('Two-factor authentication is not set up on this account.')

  await checkCode(supabase, userId, email, factor, code, { totp: 'Incorrect code.', backup: 'Incorrect code.' }, { req })
  return regenerateBackupCodesInternal(supabase, userId)
}

async function consumeBackupCode(supabase: AdminClient, userId: string, code: string): Promise<boolean> {
  const hashes = await backupCodeHashCandidates(code.trim().toUpperCase())
  const { data, error } = await supabase
    .from('mfa_backup_codes')
    .select('id')
    .eq('user_id', userId)
    .in('code_hash', hashes)
    .is('used_at', null)
    .limit(1)
    .maybeSingle()
  // A lookup failure must not look like "that code doesn't exist" (and
  // silently eat the attempt budget): throw — checkCode refunds the slot.
  if (error) {
    console.error('[mfa] consumeBackupCode lookup failed', userId, error)
    throw new Error('Could not verify your account right now. Please try again in a moment.')
  }
  if (!data) return false

  // Re-check used_at is null in the UPDATE itself so two concurrent
  // requests racing to redeem the same code can't both succeed.
  const { data: updated, error: updateErr } = await supabase
    .from('mfa_backup_codes')
    .update({ used_at: new Date().toISOString() })
    .eq('id', data.id)
    .is('used_at', null)
    .select('id')
    .maybeSingle()
  if (updateErr) {
    console.error('[mfa] consumeBackupCode redemption failed', userId, updateErr)
    throw new Error('Could not verify your account right now. Please try again in a moment.')
  }
  return !!updated
}

export async function countRemainingBackupCodes(userId: string, supabase?: AdminClient): Promise<number> {
  const client = supabase ?? (await createAdminClient())
  const { count, error } = await client
    .from('mfa_backup_codes')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .is('used_at', null)
  if (error) {
    console.error('[mfa] countRemainingBackupCodes failed', userId, error)
    throw new Error('Could not load your backup codes right now.')
  }
  return count ?? 0
}

// ── Enrollment state & API-layer enforcement ───────────────────────────
// MFA is OPTIONAL for everyone (admin and reseller included) — recommended,
// never forced. What is enforced is the other direction: once an account HAS
// a confirmed factor, the second factor must be honoured everywhere, not
// just on page navigations. middleware.ts only guards pages (it excludes
// /api), so every route that can spend money, mint credentials, redirect
// payouts, delete data or perform admin actions calls requireMfaVerified().
//
// "Enrolled" is read from mfa_totp_factors (service-role only), NOT from
// profiles.mfa_enabled, so the answer can't be influenced by anything a
// user can write.
export async function isMfaEnrolled(userId: string, supabase?: AdminClient): Promise<boolean> {
  const client = supabase ?? (await createAdminClient())
  const factor = await getFactor(client, userId)
  return !!factor?.confirmed
}

export function getMfaCookieFromRequest(req: Request): string | undefined {
  const header = req.headers.get('cookie')
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (name === MFA_COOKIE_NAME) {
      const raw = part.slice(eq + 1).trim()
      try { return decodeURIComponent(raw) } catch { return raw }
    }
  }
  return undefined
}

// Same decision as requireMfaVerified() but also reports whether the account
// is enrolled, so callers that layer a password re-prompt for NON-enrolled
// accounts (lib/reauth.ts) don't need a second enrollment query.
export async function mfaGate(req: Request, userId: string): Promise<{ response: NextResponse | null; enrolled: boolean }> {
  let enrolled: boolean
  try {
    enrolled = await isMfaEnrolled(userId)
  } catch {
    return {
      enrolled: false,
      response: NextResponse.json(
        { error: 'Could not verify your account right now. Please try again in a moment.' },
        { status: 503 }
      ),
    }
  }
  if (!enrolled) return { response: null, enrolled: false }

  let verified: boolean
  try {
    verified = await checkVerifiedSession(getMfaCookieFromRequest(req), userId, { throwOnError: true })
  } catch {
    return {
      enrolled: true,
      response: NextResponse.json(
        { error: 'Could not verify your account right now. Please try again in a moment.' },
        { status: 503 }
      ),
    }
  }
  if (!verified) {
    return {
      enrolled: true,
      response: NextResponse.json(
        {
          error: 'Two-factor verification required. Please verify your code, then retry.',
          code: 'mfa_required',
          redirect: '/auth/mfa-verify',
        },
        { status: 403 }
      ),
    }
  }
  return { response: null, enrolled: true }
}

// Returns a NextResponse to send back (403 if an enrolled account hasn't
// completed — or has let expire — its TOTP step-up; 503 if enrollment state
// can't be determined, failing closed), or null to continue. Accounts that
// never enrolled pass straight through.
export async function requireMfaVerified(req: Request, userId: string): Promise<NextResponse | null> {
  return (await mfaGate(req, userId)).response
}

// ── Verified sessions (custom step-up cookie) ────────────────────────────
// Supabase's own session has no idea our TOTP step-up happened — this is a
// second, independent proof. Opaque random token in the cookie, only its
// SHA-256 hash stored server side.
async function createVerifiedSession(
  supabase: AdminClient,
  userId: string,
  ttlMs: number,
  meta: { req?: Request; remembered?: boolean; authSessionId?: string | null } = {},
): Promise<{ token: string; ttlS: number }> {
  // A browser that already holds a verified token for THIS account and is
  // verifying again replaces it, instead of leaving the old row behind (it
  // would show up as a duplicate in the trusted-browser list until expiry).
  const previous = meta.req ? getMfaCookieFromRequest(meta.req) : undefined
  if (previous) {
    await supabase.from('mfa_verified_sessions')
      .delete().eq('token_hash', await sha256Hex(previous)).eq('user_id', userId)
  }
  const token = randomHexToken()
  const tokenHash = await sha256Hex(token)
  const expiresAt = new Date(Date.now() + ttlMs).toISOString()
  const row = {
    token_hash: tokenHash,
    user_id: userId,
    expires_at: expiresAt,
    remembered: !!meta.remembered,
    user_agent: meta.req?.headers.get('user-agent')?.slice(0, 300) ?? null,
    ip: meta.req?.headers.get('cf-connecting-ip') ?? null,
  }
  // auth_session_id (migration 0071) ties this proof to the login session it was
  // earned in, so signing that device out also ends its 2FA trust. If the
  // migration has not been applied yet, fall back to the old row shape rather
  // than breaking every verification.
  let { error } = await supabase.from('mfa_verified_sessions').insert({ ...row, auth_session_id: meta.authSessionId ?? null })
  if (error && /auth_session_id/i.test(error.message ?? '')) {
    console.error('[mfa] mfa_verified_sessions.auth_session_id missing — apply migration 0071', error.message)
    ;({ error } = await supabase.from('mfa_verified_sessions').insert(row))
  }
  if (error) throw new Error('Could not complete verification. Please try again.')
  return { token, ttlS: Math.floor(ttlMs / 1000) }
}

/** Mint a fresh verified session for a caller who just re-proved the factor (or just changed their password while verified). */
export async function issueVerifiedSession(userId: string, ttlMs = MFA_SESSION_TTL_MS, req?: Request, authSessionId?: string | null): Promise<{ token: string; ttlS: number }> {
  return createVerifiedSession(await createAdminClient(), userId, ttlMs, { req, authSessionId })
}

export async function checkVerifiedSession(token: string | undefined, userId: string, opts: { throwOnError?: boolean } = {}): Promise<boolean> {
  if (!token) return false
  const supabase = await createAdminClient()
  const tokenHash = await sha256Hex(token)
  const { data, error } = await supabase
    .from('mfa_verified_sessions')
    .select('user_id, expires_at')
    .eq('token_hash', tokenHash)
    .maybeSingle()
  // Fail-closed on error (returns false) rather than throwing — this runs on
  // protected page loads via the layouts. The log is what matters: a query
  // failure here is otherwise indistinguishable from "session expired".
  if (error) {
    console.error('[mfa] checkVerifiedSession query failed — treating as unverified, check this reason before assuming the session actually expired', userId, error)
    // API gates (mfaGate) ask for the error so an outage is answered 503, not as
    // "2FA required" (which sends the user to a verify page that cannot work either).
    if (opts.throwOnError) throw new Error('mfa_verified_sessions lookup failed')
    return false
  }
  if (!data || data.user_id !== userId) return false
  return new Date(data.expires_at).getTime() > Date.now()
}

export async function revokeVerifiedSession(token: string | undefined): Promise<void> {
  if (!token) return
  const supabase = await createAdminClient()
  const tokenHash = await sha256Hex(token)
  await supabase.from('mfa_verified_sessions').delete().eq('token_hash', tokenHash)
}

/**
 * Plain sign-out. A normal (12 h) verified session ends with the sign-in it
 * belonged to. A "trust this browser" session is kept on purpose, as the
 * checkbox promises and migration 0071 documents: it only ends via Revoke in
 * Settings, a password change, 2FA removal, or its own 30-day expiry.
 * Returns true when the trusted session was kept (the caller must then leave
 * the gp_mfa cookie in place, otherwise the row is orphaned and the browser
 * is asked for a code anyway).
 */
export async function endVerifiedSessionOnSignOut(token: string | undefined): Promise<boolean> {
  if (!token) return false
  const supabase = await createAdminClient()
  const tokenHash = await sha256Hex(token)
  const { data, error } = await supabase.from('mfa_verified_sessions')
    .select('remembered, expires_at').eq('token_hash', tokenHash).maybeSingle()
  if (error) {
    // Fail toward the safer outcome: end the session.
    console.error('[mfa] sign-out lookup failed; revoking', error.message)
    await supabase.from('mfa_verified_sessions').delete().eq('token_hash', tokenHash)
    return false
  }
  if (data?.remembered && new Date(data.expires_at as string).getTime() > Date.now()) return true
  await supabase.from('mfa_verified_sessions').delete().eq('token_hash', tokenHash)
  return false
}

/**
 * Remember which login session a verified/trusted browser is currently using.
 * Called at every sign-in from a browser that already holds a gp_mfa cookie, so
 * a later "sign this device out" can end that browser's 2FA trust as well (a
 * trusted browser survives sign-out by design, but not a revoke from Settings).
 * Best-effort: never allowed to break a sign-in.
 */
export async function bindVerifiedSessionToAuthSession(userId: string, token: string | undefined, authSessionId: string | null): Promise<void> {
  if (!token || !authSessionId) return
  try {
    const supabase = await createAdminClient()
    const { error } = await supabase.from('mfa_verified_sessions')
      .update({ auth_session_id: authSessionId })
      .eq('token_hash', await sha256Hex(token)).eq('user_id', userId)
    if (error) console.error('[mfa] bindVerifiedSessionToAuthSession failed', userId, error.message)
  } catch (e) {
    console.error('[mfa] bindVerifiedSessionToAuthSession threw', userId, e)
  }
}

/** Ends the 2FA trust of every browser last seen under this login session (device sign-out). */
export async function revokeVerifiedSessionsForAuthSession(userId: string, authSessionId: string): Promise<void> {
  try {
    const supabase = await createAdminClient()
    const { error } = await supabase.from('mfa_verified_sessions').delete().eq('user_id', userId).eq('auth_session_id', authSessionId)
    if (error) console.error('[mfa] revokeVerifiedSessionsForAuthSession failed', userId, error.message)
  } catch (e) {
    console.error('[mfa] revokeVerifiedSessionsForAuthSession threw', userId, e)
  }
}

/** Revoke every verified browser for the user except (optionally) the one holding `keepToken`. */
export async function revokeOtherVerifiedSessions(userId: string, keepToken?: string): Promise<void> {
  const supabase = await createAdminClient()
  let q = supabase.from('mfa_verified_sessions').delete().eq('user_id', userId)
  if (keepToken) q = q.neq('token_hash', await sha256Hex(keepToken))
  const { error } = await q
  if (error) console.error('[mfa] revokeOtherVerifiedSessions failed', userId, error)
}

export const ADMIN_2FA_REQUIRED_MSG = 'Two-factor authentication is required for administrator accounts and cannot be turned off. To move to a new phone, use "Change authenticator".'

async function isAdminAccount(supabase: AdminClient, userId: string): Promise<boolean> {
  const { data, error } = await supabase.from('profiles').select('role').eq('id', userId).maybeSingle()
  if (error) {
    console.error('[mfa] role lookup failed', userId, error.message)
    // Fail toward keeping 2FA on: an unreadable role is treated as "admin" for a disable request.
    return true
  }
  return data?.role === 'admin'
}

// ── Disable / reset ──────────────────────────────────────────────────
// Self-service disable requires proof of a currently-valid code (TOTP or
// backup), so a hijacked already-authenticated browser can't unilaterally
// turn MFA off without also possessing the second factor.
export async function disableMfa(userId: string, email: string, code: string, req?: Request): Promise<void> {
  const supabase = await createAdminClient()
  const factor = await getFactor(supabase, userId)
  if (!factor?.confirmed) throw new Error('Two-factor authentication is not currently enabled.')

  // Administrator accounts must keep a second factor (middleware + authorizeAdmin enforce it);
  // switching devices goes through "Change authenticator" instead. Checked before the code so
  // a refused request costs no attempt.
  if (await isAdminAccount(supabase, userId)) throw new Error(ADMIN_2FA_REQUIRED_MSG)

  await checkCode(supabase, userId, email, factor, code, { totp: 'Incorrect code.', backup: 'Incorrect code.' }, { req })
  await wipeMfa(supabase, userId)
}

// Support-desk recovery path: a user who lost both their authenticator and
// every backup code has no self-service way back in by design. An admin with
// out-of-band identity verification is the escape hatch — see
// app/api/admin/mfa-reset/route.ts.
export async function adminResetMfa(userId: string): Promise<void> {
  const supabase = await createAdminClient()
  await wipeMfa(supabase, userId)
}

/** The GoTrue session id carried in an access token (null if absent/unparseable). */
export { sessionIdFromJwt } from '@/lib/sessionDevices'

export async function revokeOtherSessions(userId: string, keepSessionId?: string | null): Promise<void> {
  try {
    const supabase = await createAdminClient()
    const { error } = await supabase.rpc('revoke_other_auth_sessions', { p_user_id: userId, p_keep: keepSessionId ?? null })
    if (error) throw error
  } catch (e) {
    console.error('[mfa] revokeOtherSessions failed', userId, e)
  }
}

// One Postgres transaction via wipe_mfa() (migrations 0024 / 0053).
async function wipeMfa(supabase: AdminClient, userId: string): Promise<void> {
  const { error } = await supabase.rpc('wipe_mfa', { p_user_id: userId })
  if (error) throw new Error('Could not reset MFA. Please try again.')
}

// ── Trusted browsers ─────────────────────────────────────────────────────
// Every verified browser (12h sessions and 30-day "trusted" ones) is listed
// so the owner can see and revoke any of them individually. The id handed to
// the client is the first 16 hex chars of the stored token hash — enough to
// address a row, useless as a credential (the cookie holds the raw token).
export interface TrustedBrowser {
  id: string
  remembered: boolean
  created_at: string
  expires_at: string
  user_agent: string | null
  ip: string | null
  current: boolean
}

export async function listTrustedBrowsers(userId: string, currentToken?: string): Promise<TrustedBrowser[]> {
  const supabase = await createAdminClient()
  const { data, error } = await supabase
    .from('mfa_verified_sessions')
    .select('token_hash, remembered, created_at, expires_at, user_agent, ip')
    .eq('user_id', userId)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) throw new Error('Could not load your trusted browsers right now.')
  const currentHash = currentToken ? await sha256Hex(currentToken) : null
  return (data ?? []).map(r => ({
    id: r.token_hash.slice(0, 16),
    remembered: !!r.remembered,
    created_at: r.created_at,
    expires_at: r.expires_at,
    user_agent: r.user_agent,
    ip: r.ip,
    current: currentHash === r.token_hash,
  }))
}

export async function revokeTrustedBrowser(userId: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f]{16}$/.test(id)) return false
  const supabase = await createAdminClient()
  const { data, error } = await supabase
    .from('mfa_verified_sessions')
    .delete()
    .eq('user_id', userId)
    .like('token_hash', `${id}%`)
    .select('token_hash')
  if (error) throw new Error('Could not revoke that browser. Please try again.')
  return (data?.length ?? 0) > 0
}
