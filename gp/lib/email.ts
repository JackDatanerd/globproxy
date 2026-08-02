// Various emails across the app (reseller approval/rejection, suspension,
// account deletion, the admin reseller-application notice) interpolate
// user-controlled fields — full_name, company_name, country, phone, etc. —
// directly into HTML email bodies. Any of those were previously inserted
// unescaped, so a user could set e.g. their signup full_name to
// `<img src=x onerror=...>` and have it render live in an email opened by
// staff or another user. escapeHtml() should wrap every such interpolation.
export function escapeHtml(input: unknown): string {
  const s = input == null ? '' : String(input)
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

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
