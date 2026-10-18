import { sendEmail, escapeHtml } from '@/lib/email'

// Admin alert for any payment-pipeline situation a human has to look at:
// money taken but not credited, mismatches, refunds, disputes. Never throws —
// an alerting failure must not turn a handled payment into a crash.
export async function alertAdminPayment(subject: string, fields: Record<string, unknown>): Promise<void> {
  try {
    const to = process.env.ADMIN_EMAIL
    if (!to) {
      console.error('[payment-alert] ADMIN_EMAIL not set — alert not sent:', subject, fields)
      return
    }
    const rows = Object.entries(fields)
      .map(([k, v]) => `<p><strong>${escapeHtml(k)}:</strong> ${escapeHtml(v)}</p>`)
      .join('')
    await sendEmail({
      to,
      subject: `[PAYMENT] ${subject}`,
      html: `${rows}<a href="${process.env.NEXT_PUBLIC_APP_URL ?? ''}/admin/orders">Open admin orders →</a>`,
    })
  } catch (e) {
    console.error('[payment-alert] send threw', subject, e)
  }
}
