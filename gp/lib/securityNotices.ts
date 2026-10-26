// Database-free pieces of the security e-mails, so they can be unit-tested without
// the Workers runtime (see tests/security-notices.test.mjs for the pure parts in signInNovelty.ts). lib/securityEvents.ts uses them and
// owns everything that talks to Supabase.
import { escapeHtml, securityNoticeHtml } from '@/lib/email'
import { appUrl } from '@/lib/appUrl'
import { countryName } from '@/lib/securityEventLabels'

export const APP_URL = () => appUrl()

export function resetButton(): string {
  return `
    <div style="text-align:center;margin:32px 0;">
      <a href="${APP_URL()}/auth/reset"
         style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
        Reset your password →
      </a>
    </div>`
}

export function supportLine(): string {
  return `
    <p style="color:#888;font-size:13px;text-align:center;">
      Still locked out, or think something else is wrong?
      <a href="mailto:support@globproxy.com" style="color:#2563eb;">Contact support</a>.
    </p>`
}


// ── Durable account notices ─────────────────────────────────────────────
// Everything below is rendered from a stored security_events row, so the same e-mail comes
// out whether it is sent the moment the event happens or by the cron sweep after a provider
// outage. Add an event here AND to DURABLE_NOTICE_EVENTS to make its e-mail retryable.
const mfaFooter = () => `
  <p style="color:#888;font-size:13px;text-align:center;">
    <a href="mailto:support@globproxy.com" style="color:#2563eb;">Contact support</a>.
  </p>`

type NoticeProfile = { email: string; full_name: string | null }
export type NoticeRow = { event: string; ip: string | null; user_agent: string | null; meta: Record<string, unknown> | null }

export const DURABLE_NOTICE_EVENTS: ReadonlySet<string> = new Set([
  'mfa_enabled', 'mfa_disabled', 'mfa_backup_regenerated', 'mfa_rekeyed', 'mfa_reset_by_admin', 'mfa_locked', 'login_throttled', 'login', 'mfa_recovery_completed',
])

export function renderSecurityNotice(row: NoticeRow, profile: NoticeProfile): { to: string; subject: string; html: string } | null {
  const name = escapeHtml(profile.full_name) || 'there'
  const email = escapeHtml(profile.email)
  const ip = row.ip
  const where = countryName(typeof row.meta?.country === 'string' ? (row.meta.country as string) : null)
  const p = (t: string) => `<p style="color:#444;text-align:center;">${t}</p>`
  const make = (subject: string, heading: string, bodyHtml: string) => ({ to: profile.email, subject, html: securityNoticeHtml({ heading, bodyHtml }) })

  switch (row.event) {
    case 'mfa_enabled':
      return make('Two-factor authentication was enabled', '2FA enabled',
        p(`Hi ${name}, this confirms two-factor authentication was just turned on for your GlobProxy account (${email}). If you made this change, no action is needed — keep your backup codes somewhere safe.`) +
        p(`If you didn't make this change, contact support immediately — someone else may already have both your password and control of the authenticator now attached to your account.`) + mfaFooter())
    case 'mfa_disabled':
      return make('Two-factor authentication was turned off', '2FA disabled',
        p(`Hi ${name}, this confirms two-factor authentication was just turned off on your GlobProxy account (${email}). If you made this change, no action is needed.`) +
        p(`If you didn't make this change, reset your password right away and turn two-factor authentication back on — that is faster than waiting on a reply from us.`) +
        resetButton() + supportLine())
    case 'mfa_backup_regenerated':
      return make('Your GlobProxy backup codes were regenerated', 'Backup codes regenerated',
        p(`Hi ${name}, this confirms new two-factor backup codes were just generated for your GlobProxy account (${email}). Your old backup codes no longer work. If you made this change, no action is needed.`) +
        p(`If you didn't make this change, contact support immediately.`) + mfaFooter())
    case 'mfa_rekeyed':
      return make('Your two-factor authenticator was changed', 'Authenticator changed',
        p(`Hi ${name}, the authenticator app for your GlobProxy account (${email}) was just replaced with a new one. Browsers that were trusted for two-factor have been signed out of that trust. If you made this change, no action is needed.`) +
        p(`If you didn't make this change, someone has your password and controls the account's second factor — contact support immediately, then reset your password.`) +
        resetButton() + supportLine())
    case 'mfa_reset_by_admin':
      return make('Two-factor authentication was reset on your GlobProxy account', '2FA reset',
        p(`Hi ${name}, our support team reset two-factor authentication on your GlobProxy account (${email}), so it is now switched off. We strongly recommend turning it back on from Settings.`) +
        p(`If you didn't request this, sign in now, change your password and re-enable two-factor authentication right away — you don't need to wait on a reply from us to lock things back down.`) +
        `<div style="text-align:center;margin:32px 0;"><a href="${APP_URL()}/dashboard/settings" style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">Go to account settings →</a></div>` +
        supportLine())
    case 'mfa_recovery_completed':
      return make('Two-factor authentication was removed from your account', '2FA removed',
        p(`Hi ${name}, two-factor authentication was removed from your GlobProxy account (${email}) through the recovery process. Turn it back on in Settings as soon as you have a new authenticator.`) +
        p(`If this wasn't you, reset your password immediately and contact support.`) +
        resetButton() + supportLine())
    case 'mfa_locked':
      return make('Too many incorrect two-factor codes on your GlobProxy account', '2FA temporarily locked',
        p(`Hi ${name}, several incorrect two-factor codes were entered for your GlobProxy account${ip ? ` (most recently from ${escapeHtml(ip)})` : ''}, so code entry is paused for 15 minutes.`) +
        p(`If that was you, just wait and try again. If it wasn't, someone may know your password — reset it now.`) +
        resetButton() + supportLine())
    case 'login_throttled':
      return make('Repeated failed sign-in attempts on your GlobProxy account', 'Sign-in paused',
        p(`Hi ${name}, there were many failed attempts to sign in to your GlobProxy account (${email})${ip ? `, most recently from ${escapeHtml(ip)}` : ''}. Sign-in is paused for 15 minutes.`) +
        p(`If that was you, wait and try again. If it wasn't, someone is guessing your password — reset it now and consider turning on two-factor authentication.`) +
        resetButton() + supportLine())
    case 'login': {
      // Only a login recorded as a new device / country is ever queued with notify = true.
      const ua = row.user_agent
      return make('New sign-in to your GlobProxy account', 'New sign-in',
        p(`Hi ${name}, your GlobProxy account (${email}) was just signed in to from a device or place we haven't seen recently.`) +
        `<p style="color:#444;text-align:center;font-size:13px;">${ip ? `IP address: ${escapeHtml(ip)}<br/>` : ''}${where ? `Location: ${escapeHtml(where)}<br/>` : ''}${ua ? `Browser: ${escapeHtml(ua.slice(0, 120))}` : ''}</p>` +
        p(`If this was you, no action is needed. If not, reset your password right away.`) +
        resetButton() + supportLine())
    }
    default:
      return null
  }
}

