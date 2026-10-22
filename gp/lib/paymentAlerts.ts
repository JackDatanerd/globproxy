import { sendEmail, escapeHtml } from '@/lib/email'
import { appUrl } from '@/lib/appUrl'
import type { createAdminClient } from '@/lib/supabase/server'

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
      html: `${rows}<a href="${appUrl()}/admin/orders">Open admin orders →</a>`,
    })
  } catch (e) {
    console.error('[payment-alert] send threw', subject, e)
  }
}

// A payment that does not match its order is looked at again and again — every
// verify call from the customer's browser, every hourly reconcile pass for days.
// Each look used to send the admin the same e-mail. This sends it ONCE per order:
// the order is stamped (orders.mismatch_alerted_at, migration 0065) and later
// looks stay quiet. If the stamp itself cannot be written the alert is sent
// anyway — a duplicate is better than silence about money. Returns true when an
// alert went out.
export async function alertMismatchOnce(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  orderId: string,
  subject: string,
  fields: Record<string, unknown>,
): Promise<boolean> {
  try {
    const { data, error } = await supabase.from('orders')
      .update({ mismatch_alerted_at: new Date().toISOString() })
      .eq('id', orderId).is('mismatch_alerted_at', null).select('id')
    if (error) console.error('[payment-alert] could not stamp mismatch_alerted_at', orderId, error)
    else if (!data || data.length === 0) return false // already alerted
  } catch (e) {
    console.error('[payment-alert] mismatch stamp threw', orderId, e)
  }
  await alertAdminPayment(subject, fields)
  return true
}
