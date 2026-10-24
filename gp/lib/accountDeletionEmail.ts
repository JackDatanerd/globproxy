import { escapeHtml } from '@/lib/email'
import { adminNoticeHtml } from '@/lib/adminEmail'
import { appUrl } from '@/lib/appUrl'

// E-mails around account deletion. Kept in one place so the route (scheduled / cancelled)
// and the hourly task (reminder / done) say the same things.

const fmtDate = (d: Date | string) =>
  new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })

const settingsHref = () => `${appUrl()}/dashboard/settings#delete-account`

export function deletionScheduledEmail(fullName: string | null | undefined, when: Date | string) {
  return {
    subject: 'Your GlobProxy account will be deleted — cancel any time before then',
    html: adminNoticeHtml({
      heading: 'Account deletion scheduled',
      bodyHtml: `Hi ${escapeHtml(fullName) || 'there'}, your GlobProxy account is scheduled to be permanently deleted on <strong>${fmtDate(when)}</strong>. Until then nothing changes — your proxies keep working and you can still sign in.
        If you did not ask for this, someone else may have access to your account: cancel the deletion below and change your password now. Once the account is deleted, unused bandwidth and any unpaid affiliate earnings cannot be recovered.`,
      cta: { href: settingsHref(), label: 'Cancel deletion →' },
    }),
  }
}

export function deletionReminderEmail(fullName: string | null | undefined, when: Date | string) {
  return {
    subject: 'Reminder: your GlobProxy account is deleted tomorrow',
    html: adminNoticeHtml({
      heading: 'Your account will be deleted soon',
      bodyHtml: `Hi ${escapeHtml(fullName) || 'there'}, this is a reminder that your GlobProxy account will be permanently deleted on <strong>${fmtDate(when)}</strong>. If you have changed your mind, cancel it before then.`,
      cta: { href: settingsHref(), label: 'Cancel deletion →' },
    }),
  }
}

export function deletionCancelledEmail(fullName: string | null | undefined) {
  return {
    subject: 'Your GlobProxy account deletion was cancelled',
    html: adminNoticeHtml({
      heading: 'Deletion cancelled',
      bodyHtml: `Hi ${escapeHtml(fullName) || 'there'}, the scheduled deletion of your GlobProxy account was cancelled and your account stays as it is. If you did not do this, contact support and change your password.`,
      cta: { href: 'mailto:support@globproxy.com', label: 'Contact support →' },
    }),
  }
}

export function deletionCompleteEmail(fullName: string | null | undefined) {
  return {
    subject: 'Your GlobProxy account has been deleted',
    html: adminNoticeHtml({
      heading: 'Account deleted',
      bodyHtml: `Hi ${escapeHtml(fullName) || 'there'}, your GlobProxy account has been permanently deleted as requested. Your name, payout details and proxy credentials have been removed and the account can no longer be signed in to. The sign-in email address is kept on a disabled record so the account can&rsquo;t be re-registered or reactivated. Records of past payments are kept as required for accounting. If you did not request this, please contact us immediately.`,
      cta: { href: 'mailto:support@globproxy.com', label: 'Contact support →' },
    }),
  }
}
