'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'
import { parseEmailList, MAX_SUBJECT, MAX_BODY } from '@/lib/broadcastRules'
import { formatUtc, formatEat } from '@/lib/promo'

type AudienceKey = 'all' | 'user' | 'reseller' | 'buyers' | 'never_bought' | 'selected'
interface Preview { eligible: number; emailable: number; unmatched: string[] }

const AUDIENCES: Array<[AudienceKey, string, string]> = [
  ['all', 'Everyone', 'every account that can be messaged'],
  ['user', 'Customers', 'regular accounts (not resellers)'],
  ['reseller', 'Resellers', 'reseller accounts'],
  ['buyers', 'Customers who have bought', 'at least one paid order'],
  ['never_bought', 'Never bought', 'signed up, no paid order yet'],
  ['selected', 'Specific people', 'a list of e-mail addresses you paste'],
]

const inputCls = 'mt-1.5 w-full border border-border rounded-xl px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent'
const labelCls = 'text-[10px] font-mono text-muted uppercase tracking-widest'
const toInput = (iso: string | null) => (iso ? iso.slice(0, 16) : '')
const fromInput = (v: string) => (v.trim() ? `${v.trim().slice(0, 16)}:00.000Z` : '')

export default function BroadcastComposer({
  promo,
}: {
  // The M-Pesa offer as stored (any state) — used only to fill the launch template with the real percentage and deadline.
  promo: { enabled: boolean; percent: number; endsAt: string } | null
}) {
  const [kind, setKind] = useState<'marketing' | 'service'>('marketing')
  const [aud, setAud] = useState<AudienceKey>('all')
  const [emailsText, setEmailsText] = useState('')
  const [sendEmail, setSendEmail] = useState(true)
  const [showBanner, setShowBanner] = useState(false)
  const [bannerEndsAt, setBannerEndsAt] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [ctaLabel, setCtaLabel] = useState('')
  const [ctaUrl, setCtaUrl] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // One id per composed message: pressing Send twice (or retrying after a lost answer) cannot message everyone twice.
  const [requestId] = useState(() => crypto.randomUUID())

  const audiencePayload = () => aud === 'selected'
    ? { kind: 'selected', emails: parseEmailList(emailsText).emails }
    : aud === 'user' || aud === 'reseller' ? { kind: 'role', role: aud } : { kind: aud }
  const content = () => ({ kind, subject, body, ctaLabel, ctaUrl, sendEmail, showBanner, bannerEndsAt: showBanner ? fromInput(bannerEndsAt) : null })
  // Changing who or what invalidates the numbers the admin looked at.
  const touch = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPreview(null) }

  function useMpesaTemplate() {
    const live = promo && promo.enabled && Date.parse(promo.endsAt) > Date.now() ? promo : null
    if (live) {
      const day = formatUtc(live.endsAt).split(',')[0].replace(/ \d{4}$/, '')
      setSubject(`M-Pesa checkout is live — ${live.percent}% off until ${day}`)
      setBody(
        `You can now pay for GlobProxy bandwidth with M-Pesa — straight from your phone, no card needed.\n\n` +
        `To celebrate, every M-Pesa order gets ${live.percent}% off until ${formatUtc(live.endsAt)} (${formatEat(live.endsAt)} in Nairobi). ` +
        `The discount is applied automatically at checkout when you choose M-Pesa, on every order you place before then.\n\n` +
        `Your bandwidth never expires, so topping up while the offer runs costs you nothing later.`)
      setBannerEndsAt(toInput(live.endsAt))
      setShowBanner(true)
    } else {
      setSubject('You can now pay with M-Pesa')
      setBody(`You can now pay for GlobProxy bandwidth with M-Pesa — straight from your phone, no card needed. Choose M-Pesa at checkout and approve the prompt on your phone.\n\nYour bandwidth never expires, so top up whenever it suits you.`)
      toast('There is no live M-Pesa offer, so the template has no discount in it. Set one up under Settings first if you want one.', { icon: 'ℹ️', duration: 7000 })
    }
    setKind('marketing'); setCtaLabel('Pay with M-Pesa'); setCtaUrl('/dashboard/buy?method=mpesa'); setPreview(null)
  }

  async function doPreview() {
    setBusy('preview')
    const { ok, data } = await adminPost('/api/admin/broadcasts', { action: 'preview', audience: audiencePayload(), kind })
    setBusy(null)
    if (!ok) { toast.error(data.error ?? 'Could not preview'); return }
    setPreview((data as any).preview)
  }

  async function doTest() {
    setBusy('test')
    const { ok, data } = await adminPost('/api/admin/broadcasts', { action: 'test', audience: audiencePayload(), content: content() })
    setBusy(null)
    if (!ok) { toast.error(data.error ?? 'Test failed'); return }
    toast.success(`Test sent to ${(data as any).sent_to} — check how it looks, and that the unsubscribe link works`)
  }

  async function doSend() {
    if (!preview) { toast.error('Preview the audience first, so you know who this goes to.'); return }
    const lines = [
      `Send "${subject.trim()}"?`, '',
      `${preview.eligible} account${preview.eligible === 1 ? '' : 's'} match.`,
      sendEmail ? `${preview.emailable} will be e-mailed${preview.eligible - preview.emailable > 0 ? ` (${preview.eligible - preview.emailable} opted out of product news)` : ''}.` : 'No e-mail will be sent.',
      showBanner ? 'A dashboard banner will show to all of them.' : '',
      '', 'This cannot be recalled once e-mails start going out.',
    ].filter((l, i, a) => l !== '' || a[i - 1] !== '')
    if (!window.confirm(lines.join('\n'))) return
    setBusy('send')
    const { ok, status, data } = await adminPost('/api/admin/broadcasts', {
      action: 'send', requestId, audience: audiencePayload(), content: content(),
      confirm: { eligible: preview.eligible, emailable: preview.emailable },
    })
    setBusy(null)
    if (status === 409 && (data as any).preview) { setPreview((data as any).preview); toast.error(data.error ?? 'The audience changed — review and confirm again.'); return }
    if (!ok) { toast.error(data.error ?? 'Send failed'); return }
    toast.success((data as any).duplicate ? 'Already sent — showing it below.' : 'Queued. E-mails go out in batches over the next few minutes.')
    window.location.reload()
  }

  const bodyLeft = MAX_BODY - body.length
  const ready = subject.trim() && body.trim() && (sendEmail || showBanner) && (!showBanner || bannerEndsAt) && (aud !== 'selected' || parseEmailList(emailsText).emails.length > 0)

  return (
    <div className="bg-white border border-border rounded-xl p-6 mb-8">
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <h2 className="font-display font-bold text-base text-ink">New broadcast</h2>
        <button onClick={useMpesaTemplate} className="border border-border px-3 py-1.5 rounded-lg text-xs text-ink">Use the M-Pesa launch template</button>
      </div>

      <div className="grid gap-5 max-w-2xl">
        <div>
          <span className={labelCls}>What is this?</span>
          <div className="mt-1.5 flex gap-4 flex-wrap text-sm text-ink">
            <label className="flex items-center gap-2"><input type="radio" checked={kind === 'marketing'} onChange={() => touch(setKind)('marketing')} /> Product news &amp; offers <span className="text-xs text-muted">(respects unsubscribes)</span></label>
            <label className="flex items-center gap-2"><input type="radio" checked={kind === 'service'} onChange={() => touch(setKind)('service')} /> Service notice <span className="text-xs text-muted">(outage, policy change — reaches everyone)</span></label>
          </div>
          {kind === 'service' && <p className="text-[11px] text-amber-700 mt-1.5">Service notices ignore unsubscribes. Use them only for things customers need to know — never for offers.</p>}
        </div>

        <div>
          <span className={labelCls}>Who gets it</span>
          <select value={aud} onChange={e => touch(setAud)(e.target.value as AudienceKey)} className={inputCls}>
            {AUDIENCES.map(([k, l, d]) => <option key={k} value={k}>{l} — {d}</option>)}
          </select>
          {aud === 'selected' && (
            <>
              <textarea value={emailsText} onChange={e => touch(setEmailsText)(e.target.value)} rows={4} placeholder="one@example.com, two@example.com …"
                className={inputCls + ' font-mono text-xs'} />
              <span className="text-[11px] text-muted">{parseEmailList(emailsText).emails.length} valid address(es){parseEmailList(emailsText).invalid.length ? `, ${parseEmailList(emailsText).invalid.length} not recognised` : ''}.</span>
            </>
          )}
          <p className="text-[11px] text-muted mt-1.5">Never included: deleted, suspended, banned or unconfirmed accounts, or accounts scheduled for deletion.</p>
        </div>

        <div>
          <span className={labelCls}>How</span>
          <div className="mt-1.5 flex gap-5 flex-wrap text-sm text-ink">
            <label className="flex items-center gap-2"><input type="checkbox" checked={sendEmail} onChange={e => touch(setSendEmail)(e.target.checked)} /> E-mail</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={showBanner} onChange={e => touch(setShowBanner)(e.target.checked)} /> Dashboard banner</label>
          </div>
          {showBanner && (
            <label className="block mt-3">
              <span className={labelCls}>Banner shows until (UTC)</span>
              <input type="datetime-local" value={bannerEndsAt} onChange={e => setBannerEndsAt(e.target.value)} className={inputCls} />
            </label>
          )}
        </div>

        <label className="block">
          <span className={labelCls}>Subject {subject.length > MAX_SUBJECT - 20 && `(${MAX_SUBJECT - subject.length} left)`}</span>
          <input value={subject} onChange={e => setSubject(e.target.value)} maxLength={MAX_SUBJECT} className={inputCls} />
        </label>
        <label className="block">
          <span className={labelCls}>Message {bodyLeft < 500 && `(${bodyLeft} left)`}</span>
          <textarea value={body} onChange={e => setBody(e.target.value)} rows={9} maxLength={MAX_BODY} className={inputCls} />
          <span className="text-[11px] text-muted">Plain text. A blank line starts a new paragraph. Each person is greeted by first name.</span>
        </label>
        <div className="grid sm:grid-cols-2 gap-4">
          <label className="block"><span className={labelCls}>Button label (optional)</span>
            <input value={ctaLabel} onChange={e => setCtaLabel(e.target.value)} maxLength={40} className={inputCls} /></label>
          <label className="block"><span className={labelCls}>Button link (a page on this site)</span>
            <input value={ctaUrl} onChange={e => setCtaUrl(e.target.value)} placeholder="/dashboard/buy?method=mpesa" className={inputCls} /></label>
        </div>

        {preview && (
          <div className="bg-surface border border-border rounded-lg p-4 text-sm text-ink">
            <div><strong>{preview.eligible}</strong> account{preview.eligible === 1 ? '' : 's'} match.</div>
            {sendEmail && <div><strong>{preview.emailable}</strong> will be e-mailed{preview.eligible - preview.emailable > 0 && <span className="text-muted"> — {preview.eligible - preview.emailable} opted out of product news</span>}.</div>}
            {showBanner && <div>The banner will show to all {preview.eligible}.</div>}
            {preview.unmatched.length > 0 && (
              <div className="text-xs text-amber-700 mt-2">Not found, or can&apos;t be messaged ({preview.unmatched.length}): {preview.unmatched.slice(0, 8).join(', ')}{preview.unmatched.length > 8 ? ' …' : ''}</div>
            )}
          </div>
        )}

        <div className="flex gap-3 flex-wrap">
          <button onClick={doPreview} disabled={!!busy} className="border border-border px-4 py-2.5 rounded-xl text-sm text-ink disabled:opacity-60">{busy === 'preview' ? 'Checking…' : 'Preview audience'}</button>
          <button onClick={doTest} disabled={!!busy || !ready} className="border border-border px-4 py-2.5 rounded-xl text-sm text-ink disabled:opacity-60">{busy === 'test' ? 'Sending…' : 'Send a test to me'}</button>
          <button onClick={doSend} disabled={!!busy || !ready || !preview} className="bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-medium disabled:opacity-60">{busy === 'send' ? 'Sending…' : 'Send…'}</button>
        </div>
        <p className="text-[11px] text-muted -mt-2">Send a test first. Sending is enabled once you have previewed the audience.</p>
      </div>
    </div>
  )
}
