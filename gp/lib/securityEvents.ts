import { createAdminClient } from '@/lib/supabase/server'
import { sendEmailSafe, securityNoticeHtml, escapeHtml } from '@/lib/email'
import { appUrl } from '@/lib/appUrl'
import { normalizeClientIp } from '@/lib/rateLimit'

type AdminClient = Awaited<ReturnType<typeof createAdminClient>>

export type SecurityEventType =
  | 'login'
  | 'password_changed'
  | 'password_reset_requested'
  | 'payout_method_changed'
  | 'email_change_requested'
  | 'mfa_enabled'
  | 'mfa_disabled'
  | 'mfa_backup_regenerated'
  | 'mfa_backup_code_used'
  | 'mfa_locked'
  | 'mfa_reset_by_admin'
  | 'signout_others'
  | 'email_changed'
  | 'login_throttled'
  | 'mfa_browser_trusted'
  | 'mfa_browser_revoked'
  | 'session_revoked'
  | 'api_key_created'
  | 'api_key_updated'
  | 'api_key_rotated'
  | 'api_key_revoked'
  | 'webhook_created'
  | 'webhook_updated'
  | 'webhook_deleted'
  | 'webhook_secret_rotated'
  | 'account_deleted'
  | 'mfa_recovery_requested'
  | 'mfa_recovery_confirmed'
  | 'mfa_recovery_cancelled'
  | 'mfa_recovery_completed'
  | 'mfa_verified'
  | 'mfa_failed'

export function requestMeta(req?: Request): { ip: string | null; ua: string | null } {
  if (!req) return { ip: null, ua: null }
  const ip =
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    null
  const ua = req.headers.get('user-agent')?.slice(0, 300) ?? null
  return { ip, ua }
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// A "device" is approximated by the User-Agent with version numbers stripped,
// so a routine browser update doesn't look like a brand-new device.
export async function uaFingerprint(ua: string | null): Promise<string> {
  const normalized = (ua ?? 'unknown').replace(/[\d._]+/g, '').toLowerCase()
  return (await sha256Hex(normalized)).slice(0, 24)
}

/** Best-effort audit write. Never throws. */
export async function logSecurityEvent(p: {
  userId: string
  event: SecurityEventType
  actorId?: string | null
  req?: Request
  meta?: Record<string, unknown>
  notify?: boolean
  admin?: AdminClient
}): Promise<void> {
  try {
    const admin = p.admin ?? (await createAdminClient())
    const { ip, ua } = requestMeta(p.req)
    const { error } = await admin.from('security_events').insert({
      user_id: p.userId,
      actor_id: p.actorId ?? null,
      event: p.event,
      ip,
      user_agent: ua,
      meta: p.meta ?? {},
      notify: p.notify ?? false,
    })
    if (error) console.error('[security_events] insert failed', p.event, error.message)
  } catch (e) {
    console.error('[security_events] insert threw', p.event, e)
  }
}

/**
 * Records a successful sign-in and reports whether it came from a device this
 * account hasn't used in the last 180 days. The very first sign-in ever
 * recorded for an account is never "new" (nothing to compare against).
 */
export async function recordLogin(userId: string, req: Request): Promise<{ newDevice: boolean; ip: string | null; ua: string | null }> {
  const { ip, ua } = requestMeta(req)
  try {
    const admin = await createAdminClient()
    const hash = await uaFingerprint(ua)
    const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString()

    const { data: anyPrior } = await admin
      .from('security_events').select('id').eq('user_id', userId).eq('event', 'login').gte('created_at', since).limit(1)
    const { data: sameDevice } = await admin
      .from('security_events').select('id').eq('user_id', userId).eq('event', 'login')
      .eq('meta->>ua_hash', hash).gte('created_at', since).limit(1)

    await logSecurityEvent({ userId, event: 'login', req, meta: { ua_hash: hash }, admin })
    return { newDevice: (anyPrior?.length ?? 0) > 0 && (sameDevice?.length ?? 0) === 0, ip, ua }
  } catch (e) {
    console.error('[security_events] recordLogin failed', e)
    return { newDevice: false, ip, ua }
  }
}

/**
 * True when this account has signed in from this IP in the last 90 days.
 * Used only while an account is under a sustained, distributed guessing
 * attack, so the real owner on a familiar connection is never locked out by
 * strangers' failed attempts.
 */
export async function isKnownLoginIp(email: string, ip: string | null): Promise<boolean> {
  if (!ip) return false
  try {
    const admin = await createAdminClient()
    const { data: owner } = await admin.from('profiles').select('id').eq('email', email.trim().toLowerCase()).maybeSingle()
    if (!owner?.id) return false
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
    const { data } = await admin.from('security_events').select('id')
      .eq('user_id', owner.id).eq('event', 'login').eq('ip', ip).gte('created_at', since).limit(1)
    if ((data?.length ?? 0) > 0) return true
    // IPv6 clients rotate privacy addresses inside their /64, and the rate
    // limiter already treats a /64 as one client (clientKey): do the same here,
    // otherwise those users look like a new device on every login.
    if (ip.includes(':')) {
      const want = normalizeClientIp(ip)
      const { data: recent } = await admin.from('security_events').select('ip')
        .eq('user_id', owner.id).eq('event', 'login').gte('created_at', since)
        .like('ip', '%:%').order('created_at', { ascending: false }).limit(200)
      return (recent ?? []).some((r: { ip: string | null }) => !!r.ip && normalizeClientIp(r.ip) === want)
    }
    return false
  } catch (e) {
    console.error('[security_events] isKnownLoginIp failed', e)
    return false
  }
}

// ── Email templates ─────────────────────────────────────────────────────
const APP_URL = () => appUrl()

function resetButton(): string {
  return `
    <div style="text-align:center;margin:32px 0;">
      <a href="${APP_URL()}/auth/reset"
         style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
        Reset your password →
      </a>
    </div>`
}

function supportLine(): string {
  return `
    <p style="color:#888;font-size:13px;text-align:center;">
      Still locked out, or think something else is wrong?
      <a href="mailto:support@globproxy.com" style="color:#2563eb;">Contact support</a>.
    </p>`
}

export function passwordChangedHtml(fullName: string | null | undefined, email: string): string {
  return securityNoticeHtml({
    heading: 'Password changed',
    bodyHtml: `
      <p style="color:#444;text-align:center;">
        Hi ${escapeHtml(fullName) || 'there'}, this confirms the password on your GlobProxy
        account (${escapeHtml(email)}) was just changed. If you made this change, no action is needed.
      </p>
      <p style="color:#444;text-align:center;">
        If you didn't make this change, reset your password right away to lock out anyone who
        might have access — that's faster and more effective than waiting on a reply from us.
      </p>
      ${resetButton()}
      ${supportLine()}`,
  })
}

export async function sendLockoutNotice(to: string, fullName: string | null | undefined, ip: string | null) {
  await sendEmailSafe({
    to,
    subject: 'Too many incorrect two-factor codes on your GlobProxy account',
    html: securityNoticeHtml({
      heading: '2FA temporarily locked',
      bodyHtml: `
        <p style="color:#444;text-align:center;">
          Hi ${escapeHtml(fullName) || 'there'}, several incorrect two-factor codes were entered for your
          GlobProxy account${ip ? ` (most recently from ${escapeHtml(ip)})` : ''}, so code entry is paused for 15 minutes.
        </p>
        <p style="color:#444;text-align:center;">
          If that was you, just wait and try again. If it wasn't, someone may know your password —
          reset it now.
        </p>
        ${resetButton()}
        ${supportLine()}`,
    }),
  })
}

export async function sendNewDeviceNotice(to: string, fullName: string | null | undefined, ip: string | null, ua: string | null) {
  await sendEmailSafe({
    to,
    subject: 'New sign-in to your GlobProxy account',
    html: securityNoticeHtml({
      heading: 'New sign-in',
      bodyHtml: `
        <p style="color:#444;text-align:center;">
          Hi ${escapeHtml(fullName) || 'there'}, your GlobProxy account (${escapeHtml(to)}) was just signed in to
          from a device we haven't seen recently.
        </p>
        <p style="color:#444;text-align:center;font-size:13px;">
          ${ip ? `IP address: ${escapeHtml(ip)}<br/>` : ''}${ua ? `Browser: ${escapeHtml(ua.slice(0, 120))}` : ''}
        </p>
        <p style="color:#444;text-align:center;">
          If this was you, no action is needed. If not, reset your password right away.
        </p>
        ${resetButton()}
        ${supportLine()}`,
    }),
  })
}

export async function sendEmailChangeNotice(oldEmail: string, fullName: string | null | undefined, newEmailMasked: string) {
  await sendEmailSafe({
    to: oldEmail,
    subject: 'A change of email address was requested on your GlobProxy account',
    html: securityNoticeHtml({
      heading: 'Email change requested',
      bodyHtml: `
        <p style="color:#444;text-align:center;">
          Hi ${escapeHtml(fullName) || 'there'}, a request was made to change the email address on your GlobProxy
          account from ${escapeHtml(oldEmail)} to ${escapeHtml(newEmailMasked)}. Nothing changes until the new
          address is confirmed.
        </p>
        <p style="color:#444;text-align:center;">
          If you didn't request this, reset your password right away and turn on two-factor authentication.
        </p>
        ${resetButton()}
        ${supportLine()}`,
    }),
  })
}

export async function sendLoginThrottleNotice(to: string, fullName: string | null | undefined, ip: string | null) {
  await sendEmailSafe({
    to,
    subject: 'Repeated failed sign-in attempts on your GlobProxy account',
    html: securityNoticeHtml({
      heading: 'Sign-in paused',
      bodyHtml: `
        <p style="color:#444;text-align:center;">
          Hi ${escapeHtml(fullName) || 'there'}, there were many failed attempts to sign in to your GlobProxy account
          (${escapeHtml(to)})${ip ? `, most recently from ${escapeHtml(ip)}` : ''}. Sign-in is paused for 15 minutes.
        </p>
        <p style="color:#444;text-align:center;">
          If that was you, wait and try again. If it wasn't, someone is guessing your password —
          reset it now and consider turning on two-factor authentication.
        </p>
        ${resetButton()}
        ${supportLine()}`,
    }),
  })
}

/** Tripwire e-mail for a sensitive change made while signed in (API key, webhook, payout, ...). */
export async function sendSecurityChangeNotice(to: string, fullName: string | null | undefined, heading: string, detailHtml: string) {
  await sendEmailSafe({
    to,
    subject: heading,
    html: securityNoticeHtml({
      heading,
      bodyHtml: `
        <p style="color:#444;text-align:center;">Hi ${escapeHtml(fullName) || 'there'}, ${detailHtml}</p>
        <p style="color:#444;text-align:center;">
          If this wasn't you, reset your password right away and sign out of other devices.
        </p>
        ${resetButton()}
        ${supportLine()}`,
    }),
  })
}

/** Looks the user up and sends a tripwire notice; never throws. */
export async function notifySecurityChange(userId: string, heading: string, detailHtml: string): Promise<void> {
  try {
    const admin = await createAdminClient()
    const { data: p } = await admin.from('profiles').select('email, full_name, is_deleted').eq('id', userId).maybeSingle()
    if (p?.email && p.email !== '[deleted]' && !p.is_deleted) {
      await sendSecurityChangeNotice(p.email, p.full_name, heading, detailHtml)
    }
  } catch (e) {
    console.error('[security] notifySecurityChange failed', e)
  }
}

export async function sendEmailChangedNotice(oldEmail: string, fullName: string | null | undefined, newEmailMasked: string): Promise<boolean> {
  return sendEmailSafe({
    to: oldEmail,
    subject: 'The email address on your GlobProxy account was changed',
    html: securityNoticeHtml({
      heading: 'Email address changed',
      bodyHtml: `
        <p style="color:#444;text-align:center;">
          Hi ${escapeHtml(fullName) || 'there'}, the sign-in email on your GlobProxy account was just changed from
          ${escapeHtml(oldEmail)} to ${escapeHtml(newEmailMasked)}. This is the final confirmation — the change is complete.
        </p>
        <p style="color:#444;text-align:center;">
          If you didn't do this, your account may be compromised. Contact support immediately.
        </p>
        ${supportLine()}`,
    }),
  })
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@')
  if (!domain) return '***'
  return `${local.slice(0, 1)}***@${domain}`
}

// ── Deferred notices (events recorded with notify = true) ───────────────
// password_changed rows are written by a DB trigger, so they exist no matter
// how the password was changed — through our routes, or by calling the
// Supabase API directly. We deliver them immediately where we know about the
// change (flushSecurityNotices(userId)) and sweep the rest from the
// 'security' cron task (flushSecurityNotices(undefined, minAgeMs)).
export async function flushSecurityNotices(userId?: string, minAgeMs = 0): Promise<number> {
  const admin = await createAdminClient()
  let q = admin
    .from('security_events')
    .select('id, user_id, event, created_at, meta')
    .eq('notify', true)
    .is('notified_at', null)
    .order('created_at', { ascending: true })
    .limit(50)
  if (userId) q = q.eq('user_id', userId)
  if (minAgeMs > 0) q = q.lt('created_at', new Date(Date.now() - minAgeMs).toISOString())

  const { data: pending, error } = await q
  if (error) { console.error('[security_events] flush select failed', error.message); return 0 }

  let sent = 0
  for (const ev of pending ?? []) {
    // Claim first so two concurrent flushers can't both email.
    const { data: claimed } = await admin
      .from('security_events')
      .update({ notified_at: new Date().toISOString() })
      .eq('id', ev.id)
      .is('notified_at', null)
      .select('id')
      .maybeSingle()
    if (!claimed) continue

    let ok = true
    // Don't retry forever: a notice still undeliverable after a day is dropped.
    const stale = Date.now() - new Date(ev.created_at).getTime() > 24 * 60 * 60 * 1000
    if (ev.event === 'password_changed' && !stale) {
      const { data: profile } = await admin.from('profiles').select('email, full_name, is_deleted').eq('id', ev.user_id).maybeSingle()
      if (profile?.email && profile.email !== '[deleted]' && !profile.is_deleted) {
        ok = await sendEmailSafe({
          to: profile.email,
          subject: 'Your GlobProxy password was changed',
          html: passwordChangedHtml(profile.full_name, profile.email),
        })
      }
    }
    if (ev.event === 'email_changed' && !stale) {
      // Goes to the OLD address — the profile already carries the new one.
      const meta = (ev.meta ?? {}) as { old_email?: string; new_email_masked?: string }
      if (meta.old_email) {
        const { data: profile } = await admin.from('profiles').select('full_name').eq('id', ev.user_id).maybeSingle()
        // sendEmailSafe never throws — a failed provider call comes back as
        // false, which must send the event back to the queue (it is the
        // old address's only warning that the login email changed).
        ok = await sendEmailChangedNotice(meta.old_email, profile?.full_name, meta.new_email_masked ?? 'your new address')
      }
    }
    if (ok) {
      if (!stale) sent++
    } else {
      // Give the next sweep another try.
      await admin.from('security_events').update({ notified_at: null }).eq('id', ev.id)
    }
  }
  return sent
}

// ── Signup against an address that already has an account ───────────────
// The signup form answers identically for every address (no enumeration), so
// the only way the real owner learns anything is this email.
export async function sendSignupExistingNotice(to: string, state: 'active' | 'deleted') {
  const body = state === 'deleted'
    ? `<p style="color:#444;text-align:center;">
         Someone (hopefully you) tried to create a GlobProxy account with this email address. The address
         belonged to an account that has since been closed, so it can't be used to sign up again.
       </p>
       <p style="color:#444;text-align:center;">
         If you'd like to come back, contact support and we'll help. If this wasn't you, ignore this email.
       </p>
       ${supportLine()}`
    : `<p style="color:#444;text-align:center;">
         Someone (hopefully you) tried to create a GlobProxy account with this email address — but you
         already have one. Sign in instead, or reset your password if you've forgotten it.
       </p>
       <p style="text-align:center;margin:24px 0;">
         <a href="${APP_URL()}/auth/login" style="background:#fff;color:#111;border:1px solid #ccc;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold;margin-right:8px;">Sign in</a>
         <a href="${APP_URL()}/auth/reset" style="background:#111;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold;">Reset password</a>
       </p>
       <p style="color:#444;text-align:center;">If it wasn't you, ignore this email — nothing has changed.</p>
       ${supportLine()}`
  await sendEmailSafe({
    to,
    subject: state === 'deleted' ? 'About signing up to GlobProxy' : 'You already have a GlobProxy account',
    html: securityNoticeHtml({ heading: state === 'deleted' ? 'This address can\'t be reused' : 'You already have an account', bodyHtml: body }),
  })
}

// ── Backup codes running low ───────────────────────────────────────────
export async function sendBackupCodesLowNotice(to: string, fullName: string | null | undefined, remaining: number) {
  await sendEmailSafe({
    to,
    subject: remaining === 0 ? 'You have no GlobProxy backup codes left' : 'Your GlobProxy backup codes are running low',
    html: securityNoticeHtml({
      heading: remaining === 0 ? 'No backup codes left' : 'Backup codes running low',
      bodyHtml: `
        <p style="color:#444;text-align:center;">
          Hi ${escapeHtml(fullName) || 'there'}, a backup code was just used to sign in to your GlobProxy account.
          You have <strong>${remaining}</strong> left.
        </p>
        <p style="color:#444;text-align:center;">
          Sign in and generate a fresh set under Settings → Two-factor authentication so you don't get locked
          out if you lose your authenticator. If you didn't use a backup code, reset your password now.
        </p>
        ${resetButton()}
        ${supportLine()}`,
    }),
  })
}
