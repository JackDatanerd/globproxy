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

// Shared branded shell for security-relevant account-change notices —
// same visual shape notify-password-changed/route.ts established, pulled
// out here since MFA enable/disable/backup-code-regen need the identical
// wrapper with only the heading and middle paragraph(s) differing. New
// additions in this family (email-changed, api-key-created, etc.) should
// build on this rather than re-copying the wrapper markup by hand.
export function securityNoticeHtml(opts: { heading: string; bodyHtml: string }): string {
  return `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
      <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
        style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
      <h2 style="text-align:center;color:#111;">${opts.heading}</h2>
      ${opts.bodyHtml}
      <p style="color:#bbb;font-size:12px;text-align:center;margin-top:32px;">
        © ${new Date().getFullYear()} GlobProxy · Residential Proxies That Never Expire
      </p>
    </div>
  `
}

export function htmlToText(html: string): string {
  return html
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => `${label.replace(/<[^>]+>/g, '').trim()} (${href})`)
    .replace(/<(br|\/p|\/h\d|\/div)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&') // &amp; LAST so "&amp;lt;" decodes to "&lt;", not "<"
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Extra message headers (List-Unsubscribe ...). Names and values are checked here, not trusted from the caller:
// CR/LF in either would let a value start a new header.
function safeHeaders(h: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!h) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(h)) {
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(k)) continue
    out[k] = sanitizeHeaderValue(String(v))
  }
  return Object.keys(out).length ? out : undefined
}

export async function sendEmail(p: { to: string; subject: string; html: string; replyTo?: string; idempotencyKey?: string; headers?: Record<string, string> }) {
  // Enforced here, not just at each call site, so a future caller that
  // interpolates user input into `subject` can't reintroduce this by
  // forgetting to sanitize it themselves.
  const safeSubject = sanitizeHeaderValue(p.subject)
  if (!process.env.RESEND_API_KEY) {
    // Without this the request went out as "Bearer undefined" and failed with a
    // confusing 401 for every email in the product.
    throw new Error('RESEND_API_KEY is not configured')
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json',
      // Lets a retry of the SAME message (sendEmailSafe) be recognised by the provider, so a
      // first attempt that timed out after being accepted is not delivered twice.
      ...(p.idempotencyKey ? { 'Idempotency-Key': p.idempotencyKey } : {}),
    },
    // A plain-text alternative alongside the HTML: mail clients that block
    // images/HTML still show something readable, and HTML-only mail scores worse with spam filters.
    body: JSON.stringify({
      from: resolveFromHeader(), to: p.to, subject: safeSubject, html: p.html, text: htmlToText(p.html),
      // Lets staff answer a customer's report by simply hitting Reply. Header-safe:
      // CR/LF are stripped like the subject.
      ...(p.replyTo ? { reply_to: sanitizeHeaderValue(p.replyTo) } : {}),
      ...(safeHeaders(p.headers) ? { headers: safeHeaders(p.headers) } : {}),
    }),
    // Without a bound, one hung provider call would hold every request that
    // awaits an e-mail (2FA confirm, disable, recovery, ...) until the platform kills it.
    signal: AbortSignal.timeout(10_000),
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

// For security-notice emails sent from inside a request handler. Awaiting is
// deliberate: on Cloudflare Workers an un-awaited fetch can be cancelled the
// moment the response is returned (see the waitUntil note in lib/apiAuth.ts),
// which silently dropped the "2FA was turned off" tripwire emails. This
// awaits, swallows (and logs) any failure — a notice that can't be delivered
// must never fail or roll back the account change it describes — and reports
// whether the provider accepted the message.
export async function sendEmailSafe(p: { to: string; subject: string; html: string; replyTo?: string }): Promise<boolean> {
  // One retry on the failures that are the provider's, not ours: a network error / timeout,
  // 429, or 5xx. A 4xx (bad key, rejected recipient) is not retried — it would fail the same
  // way. The Idempotency-Key makes the retry safe if the first attempt was actually accepted.
  const idempotencyKey = crypto.randomUUID()
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await sendEmail({ ...p, idempotencyKey })
      if (res.ok) return true
      if (!(res.status === 429 || res.status >= 500)) return false
    } catch (e) {
      console.error('[email] send threw', { to: p.to, subject: p.subject, attempt }, e)
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 700))
  }
  return false
}

// Up to 100 distinct messages in ONE provider call (a broadcast would otherwise spend one subrequest per
// recipient, and Workers cap those per invocation). Reports the HTTP status instead of throwing so the
// caller can tell "the provider did not take it" (429 / 5xx: safe to retry) from "we do not know" (a
// timeout: it may have been delivered, so it must NOT be retried blindly). `status: null` = no answer.
// The Idempotency-Key makes a retry of the same batch safe if the first attempt was in fact accepted.
export async function sendEmailBatch(
  items: Array<{ to: string; subject: string; html: string; headers?: Record<string, string> }>,
  opts: { idempotencyKey?: string } = {},
): Promise<{ status: number | null; detail?: string }> {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured')
  if (items.length === 0) return { status: 200 }
  if (items.length > 100) throw new Error('a batch holds at most 100 messages')
  try {
    const res = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json',
        ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
      },
      body: JSON.stringify(items.map(i => ({
        from: resolveFromHeader(), to: i.to, subject: sanitizeHeaderValue(i.subject), html: i.html, text: htmlToText(i.html),
        ...(safeHeaders(i.headers) ? { headers: safeHeaders(i.headers) } : {}),
      }))),
      signal: AbortSignal.timeout(25_000),
    })
    if (res.ok) return { status: res.status }
    const detail = (await res.text().catch(() => '')).slice(0, 300)
    console.error('[email] batch failed', { status: res.status, detail })
    return { status: res.status, detail }
  } catch (e) {
    console.error('[email] batch threw', e)
    return { status: null, detail: String((e as Error)?.message ?? e).slice(0, 300) }
  }
}
