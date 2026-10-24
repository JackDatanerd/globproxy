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

// The customer asked for a refund from Billing (app/api/dashboard/billing/refund-request).
export async function sendRefundRequestReceivedEmail(supabase: Admin, userId: string, p: {
  amountUsd: number; gb: number; invoiceNumber: string | null; withinPolicy: boolean
}) {
  const c = await customerEmail(supabase, userId)
  if (!c) return
  const what = `your order of <strong>${escapeHtml(p.gb)} GB</strong> (${money(p.amountUsd)}${p.invoiceNumber ? `, invoice ${escapeHtml(p.invoiceNumber)}` : ''})`
  await sendEmailSafe({
    to: c.email,
    subject: 'We received your GlobProxy refund request',
    html: shell('Refund request received', `
      <p style="color:#444;text-align:center;">Hi ${escapeHtml(c.first)}, we have your refund request for ${what}.</p>
      <p style="color:#444;text-align:center;">${p.withinPolicy
        ? 'It falls inside our refund window, so we will normally approve it. We reply within 2 business days.'
        : 'It falls outside our standard refund window, so a member of the team will review it. We reply within 2 business days.'}</p>
      <div style="text-align:center;margin:28px 0;">
        <a href="${appUrl()}/dashboard/billing" style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">View billing →</a>
      </div>
      <p style="color:#666;text-align:center;font-size:13px;">Please avoid using the bandwidth on this order while we review it — a refund can only take back what has not been used.</p>`),
  })
}

export async function sendRefundDeclinedEmail(supabase: Admin, userId: string, p: {
  amountUsd: number; gb: number; note: string | null
}) {
  const c = await customerEmail(supabase, userId)
  if (!c) return
  await sendEmailSafe({
    to: c.email,
    subject: 'Update on your GlobProxy refund request',
    html: shell('Refund request update', `
      <p style="color:#444;text-align:center;">Hi ${escapeHtml(c.first)}, we reviewed your refund request for ${escapeHtml(p.gb)} GB (${money(p.amountUsd)}) and are unable to approve it.</p>
      ${p.note ? `<p style="color:#444;text-align:center;">${escapeHtml(p.note)}</p>` : ''}
      <p style="color:#666;text-align:center;font-size:13px;">You can read our <a href="${appUrl()}/refunds" style="color:#2563eb;">refund policy</a>, or reply to this email / write to support@globproxy.com if you think we have this wrong.</p>`),
  })
}

// The Scale plan is sold self-serve but promises a dedicated account manager,
// white-label credentials and custom geo allocation — none of which happen by
// themselves. Sent once, when a Scale order is credited.
export async function sendScaleWelcomeEmail(supabase: Admin, userId: string, p: { gb: number }) {
  const c = await customerEmail(supabase, userId)
  if (!c) return
  await sendEmailSafe({
    to: c.email,
    subject: 'Welcome to GlobProxy Scale — let’s set up your account',
    html: shell('Welcome to Scale', `
      <p style="color:#444;text-align:center;">Hi ${escapeHtml(c.first)}, your ${escapeHtml(p.gb)} GB Scale order is live and the bandwidth is already in your account.</p>
      <p style="color:#444;text-align:center;">Scale includes a dedicated account manager, white-label credentials and custom geo allocation. A member of our team will contact you within one business day to set these up. To get started sooner, reply to this email or write to support@globproxy.com with the countries you target and any branding requirements.</p>
      <div style="text-align:center;margin:28px 0;">
        <a href="${appUrl()}/dashboard/proxies" style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">Open your dashboard →</a>
      </div>`),
  })
}

// A chargeback was opened against one of the customer's payments. Nothing is taken back
// yet (disputes can be won), but new purchases are paused until it is decided — the
// customer is told why instead of meeting a bare error at checkout.
export async function sendDisputeOpenedEmail(supabase: Admin, userId: string, p: { amountUsd: number; gb: number }) {
  const c = await customerEmail(supabase, userId)
  if (!c) return
  await sendEmailSafe({
    to: c.email,
    subject: 'A payment on your GlobProxy account is under dispute',
    html: shell('Payment dispute opened', `
      <p style="color:#444;text-align:center;">Hi ${escapeHtml(c.first)}, your bank has disputed the payment of <strong>${money(p.amountUsd)}</strong> for ${escapeHtml(p.gb)} GB of bandwidth.</p>
      <p style="color:#444;text-align:center;">While the dispute is open, new purchases on your account are paused. Your existing bandwidth keeps working. If you did not mean to dispute this payment, or it was a mistake, please contact your bank and write to us at support@globproxy.com — if the dispute is withdrawn, the pause lifts automatically.</p>
      <div style="text-align:center;margin:28px 0;">
        <a href="${appUrl()}/dashboard/billing" style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">View billing →</a>
      </div>`),
  })
}

// The dispute went against us: the money was taken back by the bank, so the matching
// bandwidth is removed (never below what is already allocated) and a credit note issued.
export async function sendDisputeLostEmail(supabase: Admin, userId: string, p: {
  refundUsd: number; gbClawed: number; gbNotRecoverable: number; creditNote: string | null
}) {
  const c = await customerEmail(supabase, userId)
  if (!c) return
  const gbLine = p.gbClawed > 0
    ? `<p style="color:#444;text-align:center;">${escapeHtml(Number(p.gbClawed).toFixed(2))} GB of the bandwidth from that order has been removed from your account balance.</p>`
    : ''
  const shortLine = p.gbNotRecoverable > 0
    ? `<p style="color:#444;text-align:center;">${escapeHtml(Number(p.gbNotRecoverable).toFixed(2))} GB of it was already assigned to your proxy sessions and could not be taken back.</p>`
    : ''
  const noteLine = p.creditNote
    ? `<p style="color:#444;text-align:center;">Credit note: <strong>${escapeHtml(p.creditNote)}</strong> — it also appears on your invoice.</p>`
    : ''
  await sendEmailSafe({
    to: c.email,
    subject: 'Your payment dispute was decided — GlobProxy',
    html: shell('Payment dispute decided', `
      <p style="color:#444;text-align:center;">Hi ${escapeHtml(c.first)}, the dispute on your payment was decided in your favour with your bank, and <strong>${money(p.refundUsd)}</strong> was returned to you.</p>
      ${gbLine}${shortLine}${noteLine}
      <p style="color:#444;text-align:center;">New purchases on this account stay on hold until our team has reviewed it. Write to support@globproxy.com and we will help.</p>
      <div style="text-align:center;margin:28px 0;">
        <a href="${appUrl()}/dashboard/billing" style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">View billing →</a>
      </div>`),
  })
}

// Auto-recharge could not top the account up. `disabled` = it has been switched off.
export async function sendAutoRechargeProblemEmail(supabase: Admin, userId: string, p: {
  kind: 'failed' | 'disabled' | 'cap'; amountUsd: number; gb: number; reason?: string | null; capUsd?: number
}) {
  const c = await customerEmail(supabase, userId)
  if (!c) return
  const body = p.kind === 'cap'
    ? `<p style="color:#444;text-align:center;">Hi ${escapeHtml(c.first)}, your balance is below your auto-recharge threshold, but topping up ${escapeHtml(p.gb)} GB (${money(p.amountUsd)}) would pass the ${money(p.capUsd ?? 0)} 30-day limit you set. Nothing was charged. Raise the limit or buy bandwidth yourself from your dashboard.</p>`
    : p.kind === 'disabled'
      ? `<p style="color:#444;text-align:center;">Hi ${escapeHtml(c.first)}, auto-recharge has been switched off because the last few charges to your saved card did not go through${p.reason ? ` (${escapeHtml(p.reason)})` : ''}. You have not been charged. Add a new card and turn it back on from Billing.</p>`
      : `<p style="color:#444;text-align:center;">Hi ${escapeHtml(c.first)}, we tried to top up ${escapeHtml(p.gb)} GB (${money(p.amountUsd)}) on your saved card and it did not go through${p.reason ? ` (${escapeHtml(p.reason)})` : ''}. You have not been charged. We will try again; after a few failures auto-recharge switches itself off.</p>`
  await sendEmailSafe({
    to: c.email,
    subject: p.kind === 'cap' ? 'Auto-recharge paused — your limit was reached' : p.kind === 'disabled' ? 'Auto-recharge switched off — GlobProxy' : 'Auto-recharge payment didn’t go through',
    html: shell('Auto-recharge', `${body}
      <div style="text-align:center;margin:28px 0;">
        <a href="${appUrl()}/dashboard/billing" style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">Open billing →</a>
      </div>`),
  })
}
