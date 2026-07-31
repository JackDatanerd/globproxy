export async function sendEmail(p: { to: string; subject: string; html: string }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.FROM_EMAIL ?? 'noreply@globproxy.com', to: p.to, subject: p.subject, html: p.html }),
  })
  if (!res.ok) {
    // Previously nothing checked this — every caller in the app (payment
    // confirmations, suspension/reseller-approval notices, admin
    // low-stock/exposure alerts, bandwidth threshold alerts) silently
    // assumed success. A misconfigured RESEND_API_KEY or a rejected
    // recipient would fail every email in the product with zero visibility
    // anywhere — no logs, nothing in the admin panel, nothing.
    const body = await res.text().catch(() => '')
    console.error('[email] send failed', { to: p.to, subject: p.subject, status: res.status, body })
  }
  return res
}

export async function sendAccountDeletionEmail(p: { to: string; name: string }) {
  await sendEmail({
    to: p.to,
    subject: 'Your GlobProxy account has been deleted',
    html: `<p>Hi ${p.name},</p>
<p>Your GlobProxy account has been permanently deleted by an administrator.</p>
<p>If you believe this was a mistake, please contact us at support@globproxy.com.</p>
<p>— The GlobProxy Team</p>`,
  })
}
