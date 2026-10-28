import { sendEmailSafe, escapeHtml } from '@/lib/email'
import { appUrl } from '@/lib/appUrl'
import { INBOX_ADDRESSES } from '@/lib/inboxCore'

// The "something needs a person" e-mail for the shared inbox (support@globproxy.com).
//
// Goes to ADMIN_EMAIL — the operator's own mailbox — so a customer message is noticed even when
// nobody has /admin/inbox open. One place for it, so mail from the Worker (a customer wrote to
// support@) and mail from the dashboard ("Report an issue") alert the same way.
//
// Never to an inbox address: that mail would arrive back in the inbox and raise another alert.
// Never throws; a failed alert is logged, because the message itself is already stored.
export type InboxAlertKind = 'new' | 'reply' | 'report' | 'report_followup'

const HEADLINE: Record<InboxAlertKind, { subject: string; line: string }> = {
  new: { subject: 'New message from', line: 'wrote to support@globproxy.com' },
  reply: { subject: 'New reply from', line: 'replied in an existing conversation' },
  report: { subject: 'New issue report from', line: 'sent an issue report from the dashboard' },
  report_followup: { subject: 'Issue report follow-up from', line: 'added to an issue report from the dashboard' },
}

export async function notifyOperator(
  kind: InboxAlertKind,
  p: { customerEmail: string; subject: string; threadId: string },
): Promise<boolean> {
  const to = process.env.ADMIN_EMAIL?.trim()
  if (!to) {
    console.error('[inbox] ADMIN_EMAIL is not set: no alert sent for thread', p.threadId)
    return false
  }
  if ((INBOX_ADDRESSES as readonly string[]).includes(to.toLowerCase())) return false
  const h = HEADLINE[kind]
  const ok = await sendEmailSafe({
    to,
    subject: `[INBOX] ${h.subject} ${p.customerEmail}`.replace(/[\r\n]+/g, ' '),
    html: `<p><strong>${escapeHtml(p.customerEmail)}</strong> ${h.line}:</p>
           <p>${escapeHtml(p.subject)}</p>
           <p><a href="${appUrl()}/admin/inbox/${p.threadId}">Open in the inbox →</a></p>`,
  })
  if (!ok) console.error('[inbox] operator alert was NOT delivered for thread', p.threadId)
  return ok
}
