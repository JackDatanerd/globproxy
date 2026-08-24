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

// escapeHtml() protects the HTML *body* — it does nothing for CR/LF, which
// is the character class that actually matters for a *header* field like
// `subject`. Every subject line in this app is either a hardcoded string or
// interpolates a server-computed number/date, except
// app/api/auth/apply-reseller/route.ts, which puts the caller's own
// (fully user-controlled) full_name straight into the subject. Stripping
// CR/LF there (and, defensively, here) closes header-injection if the
// downstream provider ever passes `subject` through to a raw SMTP header
// without its own sanitization — not confirmed exploitable against Resend
// specifically, but there's no reason to depend on that.
function sanitizeHeaderValue(input: string): string {
  return input.replace(/[\r\n]+/g, ' ').trim()
}

// Bare address (no display name) is what makes an inbox show
// "noreply@globproxy.com" instead of "GlobProxy" as the sender. Normalizing
// here, once, rather than at each of the ~15 call sites, and tolerant of
// FROM_EMAIL already being set to a full "Name <addr>" string in the
// environment — only wraps it if it looks like a bare address.
function resolveFromHeader(): string {
  const raw = process.env.FROM_EMAIL?.trim()
  if (!raw) return 'GlobProxy <noreply@globproxy.com>'
  return raw.includes('<') ? raw : `GlobProxy <${raw}>`
}

export async function sendEmail(p: { to: string; subject: string; html: string }) {
  // Enforced here, not just at each call site, so a future caller that
  // interpolates user input into `subject` can't reintroduce this by
  // forgetting to sanitize it themselves.
  const safeSubject = sanitizeHeaderValue(p.subject)
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: resolveFromHeader(), to: p.to, subject: safeSubject, html: p.html }),
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
