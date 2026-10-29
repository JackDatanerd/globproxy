// Rules and rendering for admin broadcasts (lib/broadcast.ts sends them). Pure and import-free so it is
// unit-tested with `node --test` and shared by the admin form and the server — what the admin is
// shown as valid is what the server accepts.

export const MAX_SUBJECT = 150
export const MAX_BODY = 5000
export const MAX_CTA_LABEL = 40
export const MAX_SELECTED_EMAILS = 2000
export const MAX_BANNER_DAYS = 60

export type BroadcastKind = 'marketing' | 'service'
export type Audience =
  | { kind: 'all' }
  | { kind: 'role'; role: 'user' | 'reseller' }
  | { kind: 'buyers' }
  | { kind: 'never_bought' }
  | { kind: 'selected'; emails: string[] }

const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/

/** Pulls addresses out of a pasted list (commas, semicolons, spaces, new lines). */
export function parseEmailList(text: string): { emails: string[]; invalid: string[] } {
  const seen = new Set<string>()
  const invalid: string[] = []
  for (const raw of String(text ?? '').split(/[\s,;]+/)) {
    const t = raw.trim().toLowerCase()
    if (!t) continue
    if (!EMAIL.test(t) || t.length > 254) { invalid.push(raw.trim().slice(0, 60)); continue }
    seen.add(t)
  }
  return { emails: [...seen], invalid }
}

export function validateAudience(input: unknown): { ok: true; value: Audience } | { ok: false; error: string } {
  const a = input as any
  switch (a?.kind) {
    case 'all': case 'buyers': case 'never_bought': return { ok: true, value: { kind: a.kind } }
    case 'role':
      return a.role === 'user' || a.role === 'reseller' ? { ok: true, value: { kind: 'role', role: a.role } } : { ok: false, error: 'Choose customers or resellers.' }
    case 'selected': {
      if (!Array.isArray(a.emails)) return { ok: false, error: 'Add at least one e-mail address.' }
      const { emails, invalid } = parseEmailList(a.emails.map(String).join('\n'))
      if (invalid.length) return { ok: false, error: `These do not look like e-mail addresses: ${invalid.slice(0, 5).join(', ')}` }
      if (emails.length === 0) return { ok: false, error: 'Add at least one e-mail address.' }
      if (emails.length > MAX_SELECTED_EMAILS) return { ok: false, error: `At most ${MAX_SELECTED_EMAILS} addresses at a time.` }
      return { ok: true, value: { kind: 'selected', emails } }
    }
    default: return { ok: false, error: 'Choose who this goes to.' }
  }
}

/** A button target. Only this site: a relative path ("/dashboard/buy?method=mpesa") or an absolute URL on
 *  `origin`. Anything else (another host, javascript:, //evil.com) is refused, so a broadcast can never
 *  carry a customer off-site. Returns the absolute URL, or null. */
export function normalizeCtaUrl(input: string, origin: string): string | null {
  const t = String(input ?? '').trim()
  if (!t || /[\s<>"'\\]/.test(t)) return null
  let o: URL
  try { o = new URL(origin) } catch { return null }
  if (o.protocol !== 'https:' && !(o.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(o.hostname))) return null
  try {
    if (t.startsWith('/')) {
      if (t.startsWith('//')) return null
      return new URL(t, o.origin).toString()
    }
    const u = new URL(t)
    return u.origin === o.origin ? u.toString() : null
  } catch { return null }
}

export interface BroadcastContent {
  kind: BroadcastKind
  subject: string
  body: string
  ctaLabel: string | null
  ctaUrl: string | null
  sendEmail: boolean
  showBanner: boolean
  bannerEndsAt: string | null
}

export function validateContent(input: any, opts: { origin: string; now?: number }): { ok: true; value: BroadcastContent } | { ok: false; error: string } {
  const now = opts.now ?? Date.now()
  const kind = input?.kind
  if (kind !== 'marketing' && kind !== 'service') return { ok: false, error: 'Choose product news & offers, or a service notice.' }
  const subject = String(input?.subject ?? '').replace(/[\r\n]+/g, ' ').trim()
  if (!subject) return { ok: false, error: 'Add a subject.' }
  if (subject.length > MAX_SUBJECT) return { ok: false, error: `The subject is over ${MAX_SUBJECT} characters.` }
  const body = String(input?.body ?? '').replace(/\r\n/g, '\n').trim()
  if (!body) return { ok: false, error: 'Write the message.' }
  if (body.length > MAX_BODY) return { ok: false, error: `The message is over ${MAX_BODY} characters.` }

  const label = String(input?.ctaLabel ?? '').replace(/[\r\n]+/g, ' ').trim()
  const rawUrl = String(input?.ctaUrl ?? '').trim()
  let ctaLabel: string | null = null, ctaUrl: string | null = null
  if (label || rawUrl) {
    if (!label || !rawUrl) return { ok: false, error: 'A button needs both a label and a link — or neither.' }
    if (label.length > MAX_CTA_LABEL) return { ok: false, error: `The button label is over ${MAX_CTA_LABEL} characters.` }
    ctaUrl = normalizeCtaUrl(rawUrl, opts.origin)
    if (!ctaUrl) return { ok: false, error: 'The button link must be a page on this site, e.g. /dashboard/buy?method=mpesa.' }
    ctaLabel = label
  }

  const sendEmail = input?.sendEmail !== false
  const showBanner = input?.showBanner === true
  if (!sendEmail && !showBanner) return { ok: false, error: 'Choose at least one way to reach people: e-mail or the dashboard banner.' }
  let bannerEndsAt: string | null = null
  if (showBanner) {
    const t = Date.parse(String(input?.bannerEndsAt ?? ''))
    if (Number.isNaN(t)) return { ok: false, error: 'Set when the dashboard banner should stop showing.' }
    if (t <= now) return { ok: false, error: 'The banner end time is in the past.' }
    if (t > now + MAX_BANNER_DAYS * 86_400_000) return { ok: false, error: `The banner cannot run more than ${MAX_BANNER_DAYS} days — check the date.` }
    bannerEndsAt = new Date(t).toISOString()
  }
  return { ok: true, value: { kind, subject, body, ctaLabel, ctaUrl, sendEmail, showBanner, bannerEndsAt } }
}

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** "Amina Otieno" -> "Amina". Empty for anything that is not a plain name (an e-mail address, markup...). */
export function greetingName(fullName: string | null | undefined): string {
  const first = String(fullName ?? '').trim().split(/\s+/)[0] ?? ''
  if (!first || first.length > 30 || /[@<>\/\\:;{}()\d]/.test(first)) return ''
  return first
}

/** A short plain-text version of the message for the dashboard banner. */
export function bannerSummary(body: string, max = 180): string {
  const flat = String(body ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : flat.slice(0, max - 1).replace(/\s+\S*$/, '') + '…'
}

/** The e-mail. `unsubscribeUrl` is required for marketing mail (it is the footer link), absent for service notices. */
export function renderBroadcastEmail(o: {
  kind: BroadcastKind
  subject: string
  body: string
  ctaLabel: string | null
  ctaUrl: string | null
  fullName: string | null | undefined
  unsubscribeUrl: string | null
  year?: number
}): string {
  const name = greetingName(o.fullName)
  const paras = o.body.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
    .map(p => `<p style="color:#444;font-size:15px;line-height:1.6;margin:0 0 16px 0;">${esc(p).replace(/\n/g, '<br/>')}</p>`).join('\n      ')
  const cta = o.ctaLabel && o.ctaUrl
    ? `<div style="text-align:center;margin:28px 0;">
        <a href="${esc(o.ctaUrl)}" style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">${esc(o.ctaLabel)}</a>
      </div>` : ''
  const footer = o.kind === 'marketing' && o.unsubscribeUrl
    ? `You are receiving this because you have a GlobProxy account.<br/><a href="${esc(o.unsubscribeUrl)}" style="color:#999;">Unsubscribe from product news &amp; offers</a> — receipts and security notices will still reach you.`
    : 'This is a service message about your GlobProxy account.'
  return `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
      <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
        style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
      <h2 style="text-align:center;color:#111;margin:0 0 24px 0;">${esc(o.subject)}</h2>
      <p style="color:#444;font-size:15px;line-height:1.6;margin:0 0 16px 0;">${name ? `Hi ${esc(name)},` : 'Hi,'}</p>
      ${paras}
      ${cta}
      <p style="color:#999;font-size:12px;text-align:center;margin-top:32px;line-height:1.6;">${footer}</p>
      <p style="color:#bbb;font-size:12px;text-align:center;margin-top:8px;">
        © ${o.year ?? new Date().getFullYear()} GlobProxy · Residential Proxies That Never Expire
      </p>
    </div>
  `
}

/** Resend's outcome for a batch, as the sender acts on it. */
export type BatchOutcome = 'sent' | 'retry' | 'rejected' | 'config' | 'unconfirmed'
export function classifySendStatus(status: number | null): BatchOutcome {
  if (status === null) return 'unconfirmed'             // timeout / network error: it may or may not have gone out
  if (status >= 200 && status < 300) return 'sent'
  if (status === 401 || status === 403) return 'config'  // bad key / unverified domain: stop everything
  if (status === 429 || status >= 500) return 'retry'    // the provider did not accept it: safe to try again
  return 'rejected'                                      // a 4xx about the content or an address
}
