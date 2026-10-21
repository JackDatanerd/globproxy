import { createAdminClient } from '@/lib/supabase/server'
import { escapeHtml, sendEmailSafe } from '@/lib/email'
import { appUrl } from '@/lib/appUrl'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

// Customer-facing payment emails (the admin-facing alerts live in
// lib/paymentAlerts.ts). All best-effort: a mail failure must never turn a
// handled payment event into a webhook failure, so these use sendEmailSafe and
// swallow lookup errors. Copy deliberately names only GlobProxy — never an
// upstream supplier.

function shell(heading: string, body: string): string {
  return `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;">
      <h2 style="text-align:center;color:#111;">${heading}</h2>
      ${body}
      <p style="color:#bbb;font-size:12px;text-align:center;margin-top:32px;">
        © ${new Date().getUTCFullYear()} GlobProxy · Questions? support@globproxy.com
      </p>
    </div>`
}

async function customerEmail(supabase: Admin, userId: string): Promise<{ email: string; first: string } | null> {
  try {
    const { data } = await supabase.from('profiles').select('email, full_name, is_deleted').eq('id', userId).maybeSingle()
    if (!data?.email || data.is_deleted || !data.email.includes('@')) return null
    return { email: data.email, first: data.full_name?.trim().split(/\s+/)[0] || 'there' }
  } catch (e) {
    console.error('[billing-email] profile lookup failed', userId, e)
    return null
  }
}

const money = (n: number) => `$${Number(n).toFixed(2)}`

// `mpesa` is set for M-Pesa orders: the customer paid (or tried to pay) in
// shillings, so the copy names KES and M-Pesa rather than a card and a card
// issuer.
export async function sendPaymentFailedEmail(supabase: Admin, userId: string, p: {
  amountUsd: number; gb: number; reason: string | null; mpesa?: { currency: string; amount: number } | null
}) {
  const c = await customerEmail(supabase, userId)
  if (!c) return
  const amountText = p.mpesa
    ? `<strong>${escapeHtml(p.mpesa.currency)} ${escapeHtml(Number(p.mpesa.amount).toLocaleString('en-KE'))}</strong> (${money(p.amountUsd)})`
    : `<strong>${money(p.amountUsd)}</strong>`
  const what = p.mpesa ? 'M-Pesa payment' : 'payment'
  const verb = p.mpesa ? 'was not completed' : 'was declined'
  const reason = p.reason
    ? `<p style="color:#444;text-align:center;">${p.mpesa ? 'Reason given' : 'Reason given by your card issuer'}: <strong>${escapeHtml(p.reason)}</strong></p>`
    : ''
  const retryNote = p.mpesa
    ? 'If you completed the M-Pesa prompt after this message, you can ignore this email — your bandwidth is credited automatically.'
    : 'If you retried with another card and it succeeded, you can ignore this email — your bandwidth is credited automatically.'
  await sendEmailSafe({
    to: c.email,
    subject: 'Your GlobProxy payment didn’t go through',
    html: shell('Payment unsuccessful', `
      <p style="color:#444;text-align:center;">Hi ${escapeHtml(c.first)}, your ${what} of ${amountText} for ${escapeHtml(p.gb)} GB of bandwidth ${verb}, and you have not been charged.</p>
      ${reason}
      <div style="text-align:center;margin:28px 0;">
        <a href="${appUrl()}/dashboard/buy" style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">Try again →</a>
      </div>
      <p style="color:#666;text-align:center;font-size:13px;">${retryNote}</p>`),
  })
}

// `local` is the refund in the currency the customer actually paid in (M-Pesa
// orders): they see the shillings that come back, not just the USD invoice value.
export async function sendRefundEmail(supabase: Admin, userId: string, p: {
  refundUsd: number; creditNote: string | null; gbClawed: number; credited: boolean; fullyRefunded: boolean
  local?: { currency: string; amount: number } | null
}) {
  const c = await customerEmail(supabase, userId)
  if (!c) return
  const gbLine = p.credited && p.gbClawed > 0
    ? `<p style="color:#444;text-align:center;">${escapeHtml(Number(p.gbClawed).toFixed(2))} GB of the refunded bandwidth has been removed from your account balance.</p>`
    : ''
  const noteLine = p.creditNote
    ? `<p style="color:#444;text-align:center;">Credit note: <strong>${escapeHtml(p.creditNote)}</strong> — it also appears on your invoice.</p>`
    : ''
  const refundText = p.local
    ? `<strong>${escapeHtml(p.local.currency)} ${escapeHtml(Number(p.local.amount).toLocaleString('en-KE'))}</strong> (${money(p.refundUsd)} of your invoice)`
    : `<strong>${money(p.refundUsd)}</strong>`
  await sendEmailSafe({
    to: c.email,
    subject: p.local
      ? `Your GlobProxy refund of ${p.local.currency} ${Number(p.local.amount).toLocaleString('en-KE')} was processed`
      : `Your GlobProxy refund of ${money(p.refundUsd)} was processed`,
    html: shell('Refund processed', `
      <p style="color:#444;text-align:center;">Hi ${escapeHtml(c.first)}, we've refunded ${refundText} to ${p.local ? 'your M-Pesa' : 'your original payment method'}${p.fullyRefunded ? ' (this order is now fully refunded)' : ''}. ${p.local ? 'It normally reaches your M-Pesa within a short time, though it can take longer.' : 'Depending on your bank it can take a few business days to show up.'}</p>
      ${gbLine}
      ${noteLine}
      <div style="text-align:center;margin:28px 0;">
        <a href="${appUrl()}/dashboard/billing" style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">View billing →</a>
      </div>`),
  })
}
