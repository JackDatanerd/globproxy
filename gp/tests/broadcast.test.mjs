import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  parseEmailList, validateAudience, validateContent, normalizeCtaUrl, greetingName, bannerSummary,
  renderBroadcastEmail, classifySendStatus, MAX_SUBJECT, MAX_BODY, MAX_SELECTED_EMAILS,
} from '../lib/broadcastRules.ts'
import { signUnsubscribe, verifyUnsubscribe, unsubscribeUrl } from '../lib/unsubscribe.ts'
import { formatEat, formatUtc } from '../lib/promo.ts'
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const ORIGIN = 'https://globproxy.com'
const NOW = Date.parse('2026-10-30T00:00:00Z')
const good = (o = {}) => ({ kind: 'marketing', subject: 'Hello', body: 'Body text', ctaLabel: '', ctaUrl: '', sendEmail: true, showBanner: false, ...o })

// ── audience & address lists ─────────────────────────────────────────
test('pasted address lists: split on commas, spaces and lines; lowercased; de-duplicated; junk reported', () => {
  const r = parseEmailList('A@x.com, b@x.com;\nA@X.com  not-an-email c@@x.com <d@x.com>')
  assert.deepEqual(r.emails, ['a@x.com', 'b@x.com'])
  assert.equal(r.invalid.length, 3)
})

test('audience validation accepts only known shapes', () => {
  assert.deepEqual(validateAudience({ kind: 'all' }), { ok: true, value: { kind: 'all' } })
  assert.equal(validateAudience({ kind: 'role', role: 'admin' }).ok, false)   // never broadcast "to admins" by role
  assert.equal(validateAudience({ kind: 'role', role: 'reseller' }).ok, true)
  assert.equal(validateAudience({ kind: 'everyone' }).ok, false)
  assert.equal(validateAudience(null).ok, false)
  assert.equal(validateAudience({ kind: 'selected', emails: [] }).ok, false)
  assert.equal(validateAudience({ kind: 'selected', emails: ['nope'] }).ok, false)
  assert.equal(validateAudience({ kind: 'selected', emails: Array.from({ length: MAX_SELECTED_EMAILS + 1 }, (_, i) => `u${i}@x.com`) }).ok, false)
  assert.deepEqual(validateAudience({ kind: 'selected', emails: ['A@x.com', 'a@x.com'] }).value, { kind: 'selected', emails: ['a@x.com'] })
})

// ── content rules ─────────────────────────────────────────────────────
test('content: required fields, limits, and at least one channel', () => {
  assert.equal(validateContent(good(), { origin: ORIGIN, now: NOW }).ok, true)
  assert.equal(validateContent(good({ kind: 'promo' }), { origin: ORIGIN }).ok, false)
  assert.equal(validateContent(good({ subject: '  ' }), { origin: ORIGIN }).ok, false)
  assert.equal(validateContent(good({ body: '' }), { origin: ORIGIN }).ok, false)
  assert.equal(validateContent(good({ subject: 'x'.repeat(MAX_SUBJECT + 1) }), { origin: ORIGIN }).ok, false)
  assert.equal(validateContent(good({ body: 'x'.repeat(MAX_BODY + 1) }), { origin: ORIGIN }).ok, false)
  assert.equal(validateContent(good({ sendEmail: false, showBanner: false }), { origin: ORIGIN }).ok, false)
  // a newline in the subject cannot become a header
  assert.equal(validateContent(good({ subject: 'a\r\nBcc: x@evil.com' }), { origin: ORIGIN }).value.subject, 'a Bcc: x@evil.com')
})

test('a banner needs a future end, at most 60 days out', () => {
  const ok = (iso) => validateContent(good({ sendEmail: false, showBanner: true, bannerEndsAt: iso }), { origin: ORIGIN, now: NOW })
  assert.equal(ok('2026-11-06T23:59:00.000Z').ok, true)
  assert.equal(ok('').ok, false)
  assert.equal(ok('2026-10-29T00:00:00Z').ok, false)
  assert.equal(ok('2027-06-01T00:00:00Z').ok, false)
})

test('the button can only point at this site', () => {
  assert.equal(normalizeCtaUrl('/dashboard/buy?method=mpesa', ORIGIN), 'https://globproxy.com/dashboard/buy?method=mpesa')
  assert.equal(normalizeCtaUrl('https://globproxy.com/blog', ORIGIN), 'https://globproxy.com/blog')
  for (const bad of ['https://evil.com/x', '//evil.com', 'javascript:alert(1)', 'http://globproxy.com/x', 'https://globproxy.com.evil.com/', '/a b', '/x"onmouseover="', '', 'dashboard']) {
    assert.equal(normalizeCtaUrl(bad, ORIGIN), null, bad)
  }
  assert.equal(validateContent(good({ ctaLabel: 'Go', ctaUrl: '' }), { origin: ORIGIN }).ok, false)   // label without link
  assert.equal(validateContent(good({ ctaLabel: '', ctaUrl: '/x' }), { origin: ORIGIN }).ok, false)   // link without label
  assert.equal(validateContent(good({ ctaLabel: 'Go', ctaUrl: 'https://evil.com' }), { origin: ORIGIN }).ok, false)
})

// ── the e-mail itself ─────────────────────────────────────────────────
test('rendering escapes everything and keeps paragraphs', () => {
  const html = renderBroadcastEmail({ kind: 'marketing', subject: '<b>Hi</b>', body: 'One <script>x</script>\n\nTwo & three', ctaLabel: 'Go "now"', ctaUrl: 'https://globproxy.com/x?a=1&b=2', fullName: 'Amina <img src=x>', unsubscribeUrl: 'https://globproxy.com/api/unsubscribe?u=1&t=2' })
  assert.ok(!html.includes('<script>') && !html.includes('<img src=x>') && !html.includes('<b>Hi</b>'))
  assert.match(html, /One &lt;script&gt;x&lt;\/script&gt;/)
  assert.match(html, /Two &amp; three/)
  assert.match(html, /Hi Amina,/)                          // only the plain first word of the name is used; the markup is dropped
  const odd = renderBroadcastEmail({ kind: 'service', subject: 's', body: 'b', ctaLabel: null, ctaUrl: null, fullName: '<img src=x> Amina', unsubscribeUrl: null })
  assert.match(odd, /Hi,/)                                 // an unsafe-looking first word means no name at all
  assert.ok(!odd.includes('<img src=x>'))
  assert.match(html, /href="https:\/\/globproxy\.com\/x\?a=1&amp;b=2"/)
  assert.match(html, /Go &quot;now&quot;/)
})

test('marketing mail carries the unsubscribe link; a service notice says it is one and has none', () => {
  const m = renderBroadcastEmail({ kind: 'marketing', subject: 's', body: 'b', ctaLabel: null, ctaUrl: null, fullName: 'Amina Otieno', unsubscribeUrl: 'https://globproxy.com/api/unsubscribe?u=1&t=2' })
  assert.match(m, /Hi Amina,/)
  assert.match(m, /Unsubscribe from product news/)
  const s = renderBroadcastEmail({ kind: 'service', subject: 's', body: 'b', ctaLabel: null, ctaUrl: null, fullName: null, unsubscribeUrl: null })
  assert.match(s, /service message/)
  assert.ok(!/nsubscribe/.test(s))
})

test('greeting uses a plain first name only; banner text is short and flat', () => {
  assert.equal(greetingName('Amina Otieno'), 'Amina')
  for (const bad of ['', null, undefined, 'a@b.com', '<x>', 'x'.repeat(40), '123']) assert.equal(greetingName(bad), '')
  const long = 'word '.repeat(100)
  assert.ok(bannerSummary(long).length <= 180 && bannerSummary(long).endsWith('…'))
  assert.equal(bannerSummary('short\n\ntext'), 'short text')
})

test('the deadline is also given in Nairobi time', () => {
  assert.equal(formatUtc('2026-11-06T23:59:00.000Z'), '6 Nov 2026, 23:59 UTC')
  assert.equal(formatEat('2026-11-06T23:59:00.000Z'), '7 Nov 2026, 02:59 EAT')
})

// ── what each provider answer means ───────────────────────────────────
test('provider outcomes: only a 2xx is "sent"; no answer is never retried blindly', () => {
  assert.equal(classifySendStatus(200), 'sent')
  assert.equal(classifySendStatus(null), 'unconfirmed')
  assert.equal(classifySendStatus(429), 'retry')
  assert.equal(classifySendStatus(503), 'retry')
  assert.equal(classifySendStatus(401), 'config')
  assert.equal(classifySendStatus(403), 'config')
  assert.equal(classifySendStatus(422), 'rejected')
  assert.equal(classifySendStatus(400), 'rejected')
})

// ── unsubscribe tokens ────────────────────────────────────────────────
const UID = '3f2b8c1e-5a47-4d0e-9b61-0c7d2a9e4f10'
test('unsubscribe links verify for their own account only, with their own secret', async () => {
  const t = await signUnsubscribe('secret-one', UID)
  assert.equal(await verifyUnsubscribe('secret-one', UID, t), true)
  assert.equal(await verifyUnsubscribe('secret-two', UID, t), false)
  assert.equal(await verifyUnsubscribe('secret-one', '00000000-0000-4000-8000-000000000000', t), false)
  assert.equal(await verifyUnsubscribe('secret-one', UID, t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A')), false)
  assert.equal(await verifyUnsubscribe('secret-one', UID, ''), false)
  assert.equal(await verifyUnsubscribe('', UID, t), false)
  assert.equal(await verifyUnsubscribe('secret-one', "x' or 1=1 --", t), false)
  await assert.rejects(() => signUnsubscribe('', UID))
  const url = await unsubscribeUrl('https://globproxy.com/', 'secret-one', UID)
  assert.match(url, /^https:\/\/globproxy\.com\/api\/unsubscribe\?u=3f2b8c1e-.*&t=[A-Za-z0-9_-]+$/)
})

// ── wiring (source-level guards for what cannot run without a database/provider) ──
test('the sender only marks "sent" after the provider accepted the batch, and never retries a timeout', () => {
  const s = read('lib/broadcast.ts')
  assert.match(s, /if \(outcome === 'sent'\)[\s\S]*?status: 'sent'/)
  assert.match(s, /outcome === 'config'[\s\S]*?status: 'pending'[\s\S]*?stop:/)
  assert.match(s, /'interrupted: delivery unconfirmed'/)
  assert.match(s, /\.lt\('attempts', MAX_ATTEMPTS\)/)
  // marketing mail cannot go out without an unsubscribe secret
  assert.match(s, /marketing e-mail cannot be sent: no unsubscribe secret/)
  // one-click headers only on marketing
  assert.match(s, /'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'/)
})

test('the admin route validates, blocks supplier names, and is idempotent per press', () => {
  const r = read('app/api/admin/broadcasts/route.ts')
  assert.match(r, /leaksSupplier/)
  assert.match(r, /request_id/)
  assert.match(r, /Number\(body\?\.confirm\?\.eligible\) !== eligible/)
  assert.match(r, /status: 409/)
  for (const a of ['broadcast.send', 'broadcast.cancel', 'broadcast.retry']) assert.ok(r.includes(a), a)
  // the supplier's name must not be echoed back in the error
  assert.ok(!/geo\s*node/i.test(r))
})

test('unsubscribing needs the signed link, is a POST, and a GET never changes anything', () => {
  const r = read('app/api/unsubscribe/route.ts')
  assert.match(r, /export async function POST[\s\S]*?verifyUnsubscribe[\s\S]*?marketing_emails: false/)
  const get = r.slice(r.indexOf('export async function GET'))
  assert.ok(!/\.update\(/.test(get))
})

test('cron: scheduled, known, and watched for staleness', () => {
  assert.match(read('custom-worker.ts'), /'broadcasts'\]/)
  assert.match(read('app/api/cron/[task]/route.ts'), /case 'broadcasts':/)
  assert.match(read('lib/cronHealth.ts'), /broadcasts: 30 \* 60/)
})

test('the dashboard shows only banners addressed to the caller, and they can be dismissed', () => {
  const r = read('app/api/dashboard/announcements/route.ts')
  assert.match(r, /\.eq\('user_id', user\.id\)/)
  assert.match(r, /\.neq\('status', 'cancelled'\)/)
  assert.match(r, /\.gt\('banner_ends_at'/)
  assert.match(read('components/dashboard/DashShell.tsx'), /<AnnouncementBanner \/>/)
})

test('migration: service-role only, address-free recipients, re-checks eligibility at send time', () => {
  const m = read('supabase/migrations/0108_broadcasts.sql')
  assert.match(m, /alter table public\.broadcasts enable row level security/)
  assert.match(m, /revoke all on public\.broadcast_recipients from anon, authenticated/)
  assert.ok(!/create table if not exists public\.broadcast_recipients \([^;]*\bemail\b/.test(m), 'recipients must not store addresses')
  assert.match(m, /for update skip locked/)
  assert.match(m, /interrupted: delivery unconfirmed/)
  for (const fn of ['broadcast_user_ok', 'broadcast_audience', 'broadcast_preview', 'broadcast_enqueue', 'broadcast_claim', 'broadcast_progress']) {
    assert.match(m, new RegExp(`grant execute on function public\\.${fn}\\(`), fn)
  }
})
