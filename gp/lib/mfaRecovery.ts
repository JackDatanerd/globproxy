import { createAdminClient } from '@/lib/supabase/server'
import { adminResetMfa, isMfaEnrolled } from '@/lib/mfa'
import { sendEmailSafe, securityNoticeHtml, escapeHtml } from '@/lib/email'
import { logSecurityEvent } from '@/lib/securityEvents'
import { appUrl } from '@/lib/appUrl'

// Self-service recovery for someone who lost BOTH their authenticator and
// every backup code. Until now the only way back in was a support ticket and
// an admin with out-of-band identity checks, which doesn't scale and is
// itself the soft spot an attacker would social-engineer.
//
// The flow trades speed for safety. Removing 2FA this way takes THREE things
// the account owner has and a stranger (even one with the password) lacks all
// together, plus time for the real owner to object:
//   1. the signed-in account's current password      (request)
//   2. access to the account's email inbox           (confirm link)
//   3. a 48-hour waiting period, announced by e-mail (complete)
// Every e-mail carries a one-click CANCEL link. Cancelling needs nothing but
// the e-mail itself — that is exactly what the real owner uses.
export const RECOVERY_LINK_TTL_MS = 60 * 60 * 1000
export const RECOVERY_WAIT_MS = 48 * 60 * 60 * 1000

async function sha256Hex(input: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function newToken(): string {
  const a = new Uint8Array(32)
  crypto.getRandomValues(a)
  return Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('')
}

const link = (token: string) => `${appUrl()}/auth/mfa-recovery?token=${token}`

function mail(heading: string, bodyHtml: string) {
  return securityNoticeHtml({
    heading,
    bodyHtml: `${bodyHtml}<p style="color:#888;font-size:13px;text-align:center;">Questions? <a href="mailto:support@globproxy.com" style="color:#2563eb;">Contact support</a>.</p>`,
  })
}

function button(href: string, label: string, color = '#2563eb') {
  return `<div style="text-align:center;margin:28px 0;"><a href="${href}" style="background:${color};color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">${label}</a></div>`
}

export type RecoveryState = 'unknown' | 'awaiting_confirmation' | 'waiting' | 'ready' | 'cancelled' | 'completed' | 'expired'

interface Row {
  id: string
  user_id: string
  created_at: string
  expires_at: string
  confirmed_at: string | null
  ready_at: string | null
  cancelled_at: string | null
  completed_at: string | null
}

async function findByToken(token: string): Promise<Row | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null
  const admin = await createAdminClient()
  const { data, error } = await admin
    .from('mfa_recovery_requests')
    .select('id, user_id, created_at, expires_at, confirmed_at, ready_at, cancelled_at, completed_at')
    .eq('token_hash', await sha256Hex(token))
    .maybeSingle()
  if (error) throw new Error('Could not look up that recovery request right now.')
  return (data as Row) ?? null
}

function stateOf(r: Row): RecoveryState {
  if (r.completed_at) return 'completed'
  if (r.cancelled_at) return 'cancelled'
  if (!r.confirmed_at) return new Date(r.expires_at).getTime() < Date.now() ? 'expired' : 'awaiting_confirmation'
  return r.ready_at && new Date(r.ready_at).getTime() <= Date.now() ? 'ready' : 'waiting'
}

/** Step 1 — the signed-in owner (password already verified by the route) asks for recovery. */
export async function requestRecovery(userId: string, email: string, fullName: string | null | undefined, req?: Request): Promise<void> {
  if (!(await isMfaEnrolled(userId))) throw new Error('Two-factor authentication is not turned on for this account.')
  const admin = await createAdminClient()

  // Only one live request at a time: a new one supersedes the old.
  await admin.from('mfa_recovery_requests')
    .update({ cancelled_at: new Date().toISOString() })
    .eq('user_id', userId).is('cancelled_at', null).is('completed_at', null)

  const token = newToken()
  const { error } = await admin.from('mfa_recovery_requests').insert({
    user_id: userId,
    token_hash: await sha256Hex(token),
    expires_at: new Date(Date.now() + RECOVERY_LINK_TTL_MS).toISOString(),
  })
  if (error) {
    console.error('[mfaRecovery] insert failed', error.message)
    throw new Error('Could not start recovery. Please try again.')
  }
  await logSecurityEvent({ userId, event: 'mfa_recovery_requested', req, admin })

  const ok = await sendEmailSafe({
    to: email,
    subject: 'Confirm your request to remove two-factor authentication',
    html: mail('Confirm 2FA recovery', `
      <p style="color:#444;text-align:center;">
        Hi ${escapeHtml(fullName) || 'there'}, someone signed in to your GlobProxy account (${escapeHtml(email)}) and asked to
        remove two-factor authentication because the authenticator and backup codes are lost.
      </p>
      <p style="color:#444;text-align:center;">
        If that was you, open the link within one hour to start a ${RECOVERY_WAIT_MS / 3600000}-hour waiting period.
        Nothing is removed until the waiting period ends.
      </p>
      ${button(link(token), 'Continue recovery →')}
      <p style="color:#444;text-align:center;">If it wasn't you, ignore this e-mail — nothing will happen — and consider changing your password.</p>`),
  })
  if (!ok) throw new Error('We could not send the confirmation e-mail. Please try again in a moment.')
}

export async function recoveryStatus(token: string): Promise<{ state: RecoveryState; ready_at: string | null }> {
  const r = await findByToken(token)
  if (!r) return { state: 'unknown', ready_at: null }
  return { state: stateOf(r), ready_at: r.ready_at }
}

/** Step 2 — the owner opened the e-mailed link while signed in as the same account: the clock starts. */
export async function confirmRecovery(userId: string, email: string, fullName: string | null | undefined, token: string, req?: Request): Promise<{ ready_at: string }> {
  const r = await findByToken(token)
  if (!r || r.user_id !== userId) throw new Error('This recovery link is not valid for the account you are signed in to.')
  const state = stateOf(r)
  if (state === 'expired') throw new Error('This link has expired. Start recovery again.')
  if (state === 'cancelled') throw new Error('This recovery request was cancelled.')
  if (state === 'completed') throw new Error('This recovery request was already completed.')
  if (state !== 'awaiting_confirmation') return { ready_at: r.ready_at! }

  const readyAt = new Date(Date.now() + RECOVERY_WAIT_MS).toISOString()
  const admin = await createAdminClient()
  const { data: updated } = await admin.from('mfa_recovery_requests')
    .update({ confirmed_at: new Date().toISOString(), ready_at: readyAt })
    .eq('id', r.id).is('confirmed_at', null).is('cancelled_at', null)
    .select('id').maybeSingle()
  if (!updated) throw new Error('This recovery request is no longer active.')

  await sendEmailSafe({
    to: email,
    subject: 'Two-factor recovery started — you can cancel it',
    html: mail('2FA recovery started', `
      <p style="color:#444;text-align:center;">
        Hi ${escapeHtml(fullName) || 'there'}, a request to remove two-factor authentication from your GlobProxy account
        was confirmed. It will become available in ${RECOVERY_WAIT_MS / 3600000} hours.
      </p>
      <p style="color:#444;text-align:center;"><strong>If you did not ask for this, cancel it now.</strong> Then reset your password.</p>
      ${button(link(token), 'Cancel recovery', '#dc2626')}`),
  })
  return { ready_at: readyAt }
}

/** Cancel — needs only the token from the e-mail (no sign-in), so the real owner can always stop it. */
export async function cancelRecovery(token: string, req?: Request): Promise<boolean> {
  const r = await findByToken(token)
  if (!r) return false
  const state = stateOf(r)
  if (state === 'completed' || state === 'cancelled') return state === 'cancelled'
  const admin = await createAdminClient()
  const { data } = await admin.from('mfa_recovery_requests')
    .update({ cancelled_at: new Date().toISOString() })
    .eq('id', r.id).is('cancelled_at', null).is('completed_at', null)
    .select('id').maybeSingle()
  if (data) await logSecurityEvent({ userId: r.user_id, event: 'mfa_recovery_cancelled', req, admin })
  return !!data
}

/** Step 3 — after the waiting period, signed in as the same account: 2FA is removed. */
export async function completeRecovery(userId: string, email: string, fullName: string | null | undefined, token: string, req?: Request): Promise<void> {
  const r = await findByToken(token)
  if (!r || r.user_id !== userId) throw new Error('This recovery link is not valid for the account you are signed in to.')
  const state = stateOf(r)
  if (state === 'waiting') throw new Error('The waiting period has not ended yet.')
  if (state !== 'ready') throw new Error('This recovery request is not active.')

  // Claim first, so two concurrent calls can't both proceed.
  const admin = await createAdminClient()
  const { data: claimed } = await admin.from('mfa_recovery_requests')
    .update({ completed_at: new Date().toISOString() })
    .eq('id', r.id).is('completed_at', null).is('cancelled_at', null)
    .select('id').maybeSingle()
  if (!claimed) throw new Error('This recovery request is no longer active.')

  try {
    await adminResetMfa(userId)
  } catch (e) {
    await admin.from('mfa_recovery_requests').update({ completed_at: null }).eq('id', r.id)
    throw e
  }
  await logSecurityEvent({ userId, event: 'mfa_recovery_completed', req, admin })
  await sendEmailSafe({
    to: email,
    subject: 'Two-factor authentication was removed from your account',
    html: mail('2FA removed', `
      <p style="color:#444;text-align:center;">
        Hi ${escapeHtml(fullName) || 'there'}, two-factor authentication was removed from your GlobProxy account through the
        recovery process. Turn it back on in Settings as soon as you have a new authenticator.
      </p>
      <p style="color:#444;text-align:center;">If this wasn't you, reset your password immediately and contact support.</p>
      ${button(`${appUrl()}/auth/reset`, 'Reset your password →')}`),
  })
}
