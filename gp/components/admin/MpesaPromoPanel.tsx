'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'
import { applyPercent, formatUtc, MAX_PROMO_PCT, type PromoState } from '@/lib/promo'

// "2026-11-06T23:59:00.000Z" -> "2026-11-06T23:59" for <input type="datetime-local">. The input is
// only a picker for a date and time STRING: both ways it is read and written as UTC, never in the
// browser's timezone, so what the admin types is exactly what customers are told.
const toInput = (iso: string | null) => (iso ? iso.slice(0, 16) : '')
// A picker value is "YYYY-MM-DDTHH:mm" (or with seconds on some browsers); anything else is rejected by
// the server rather than guessed at.
const fromInput = (v: string) => {
  const t = v.trim()
  if (!t) return ''
  return `${t.slice(0, 16)}:00.000Z`
}

const STATE_BADGE: Record<PromoState, { text: string; cls: string }> = {
  live: { text: 'Live', cls: 'bg-green-50 text-green-700 border-green-200' },
  scheduled: { text: 'Scheduled', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  ended: { text: 'Ended', cls: 'bg-gray-100 text-gray-600 border-gray-200' },
  off: { text: 'Paused', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
}

export default function MpesaPromoPanel({
  promo, state, version, sampleUsd, sampleKes,
}: {
  promo: { enabled: boolean; percent: number; startsAt: string | null; endsAt: string; label: string } | null
  state: PromoState | null
  // platform_settings.updated_at of the offer as this page loaded it (null = there was none). Sent
  // back with every change so a stale page cannot overwrite another admin's edit.
  version: string | null
  // A worked example so the effect of the percentage is visible before saving.
  sampleUsd: number
  sampleKes: number | null
}) {
  const [percent, setPercent] = useState(promo ? String(promo.percent) : '10')
  const [label, setLabel] = useState(promo?.label ?? 'M-Pesa launch offer')
  const [startsAt, setStartsAt] = useState(toInput(promo?.startsAt ?? null))
  const [endsAt, setEndsAt] = useState(toInput(promo?.endsAt ?? null))
  const [busy, setBusy] = useState(false)

  async function send(body: Record<string, unknown>, done: string) {
    setBusy(true)
    const { ok, data } = await adminPost('/api/admin/mpesa-promo', { ...body, version })
    setBusy(false)
    if (!ok) { toast.error(data.error ?? 'Failed to save'); return }
    toast.success(done)
    window.location.reload()
  }

  function save() {
    const pct = Number(percent.trim())
    if (percent.trim() === '' || !Number.isFinite(pct)) { toast.error('The discount must be a plain number, e.g. 10'); return }
    if (!endsAt.trim()) { toast.error('Set when the offer ends (UTC)'); return }
    send({ percent: pct, label, endsAt: fromInput(endsAt), startsAt: fromInput(startsAt) || null },
      promo ? 'Offer updated' : 'Offer created')
  }

  const pctNum = Number(percent)
  const previewUsd = Number.isFinite(pctNum) && pctNum > 0 && pctNum <= MAX_PROMO_PCT ? applyPercent(sampleUsd, pctNum) : null
  const badge = state ? STATE_BADGE[state] : null

  return (
    <div className="bg-white border border-border rounded-xl p-6 mt-5">
      <div className="flex items-center gap-3 mb-1">
        <h2 className="font-display font-bold text-base text-ink">M-Pesa offer</h2>
        {badge && <span className={`text-[10px] font-mono uppercase tracking-widest border rounded px-2 py-0.5 ${badge.cls}`}>{badge.text}</span>}
      </div>
      <p className="text-xs text-muted font-light mb-4">
        A percentage off every M-Pesa order placed while the offer is live — for every order, not just the first. Card orders are never discounted.
        The discounted price is locked onto the order when it is placed, so a customer who started before the end can still finish paying.
        All times are <strong>UTC</strong> (Nairobi is UTC+3).
      </p>

      {promo && (
        <div className="bg-surface border border-border rounded-lg p-4 mb-4 text-sm">
          <div className="text-ink"><span className="font-semibold">{promo.percent}% off</span>{promo.label ? ` · ${promo.label}` : ''}</div>
          <div className="text-[11px] font-mono text-muted mt-1">
            {promo.startsAt ? `from ${formatUtc(promo.startsAt)} · ` : ''}ends {formatUtc(promo.endsAt)}
          </div>
          <div className="flex flex-wrap gap-2 mt-3">
            {[[24, '+24 hours'], [72, '+3 days'], [168, '+7 days']].map(([h, text]) => (
              <button key={h} disabled={busy} onClick={() => send({ extendHours: h }, `Offer extended (${text})`)}
                className="border border-border px-3 py-1.5 rounded-lg text-xs text-ink disabled:opacity-60">Extend {text}</button>
            ))}
            {state === 'live' || state === 'scheduled' ? (
              <button disabled={busy} onClick={() => send({ enabled: false }, 'Offer paused')}
                className="border border-border px-3 py-1.5 rounded-lg text-xs text-ink disabled:opacity-60">Pause</button>
            ) : state === 'off' ? (
              <button disabled={busy} onClick={() => send({ enabled: true }, 'Offer resumed')}
                className="border border-border px-3 py-1.5 rounded-lg text-xs text-ink disabled:opacity-60">Resume</button>
            ) : null}
            {state === 'live' && (
              <button disabled={busy} onClick={() => { if (window.confirm('End the offer now? New M-Pesa orders will be charged the full price immediately.')) send({ endNow: true }, 'Offer ended') }}
                className="border border-red-200 text-red-600 px-3 py-1.5 rounded-lg text-xs disabled:opacity-60">End now</button>
            )}
            <button disabled={busy} onClick={() => { if (window.confirm('Remove the offer entirely?')) send({ remove: true }, 'Offer removed') }}
              className="border border-border text-muted px-3 py-1.5 rounded-lg text-xs disabled:opacity-60">Remove</button>
          </div>
          <p className="text-[11px] text-muted mt-2">Extending an offer that has already ended restarts it from now.</p>
        </div>
      )}

      <div className="grid gap-4 max-w-md">
        <label className="block">
          <span className="text-[10px] font-mono text-muted uppercase tracking-widest">Discount (%)</span>
          <input value={percent} onChange={e => setPercent(e.target.value)} inputMode="decimal"
            className="mt-1.5 w-full border border-border rounded-xl px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent" />
          <span className="text-[11px] text-muted">
            1–{MAX_PROMO_PCT}.{previewUsd != null && <> Example: a ${sampleUsd.toFixed(2)} plan becomes <strong>${previewUsd.toFixed(2)}</strong>{sampleKes != null ? <> (about KES {Math.round(sampleKes * previewUsd / sampleUsd).toLocaleString('en-KE')})</> : null}.</>}
          </span>
        </label>
        <label className="block">
          <span className="text-[10px] font-mono text-muted uppercase tracking-widest">Name shown to customers</span>
          <input value={label} onChange={e => setLabel(e.target.value)} maxLength={40}
            className="mt-1.5 w-full border border-border rounded-xl px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent" />
        </label>
        <label className="block">
          <span className="text-[10px] font-mono text-muted uppercase tracking-widest">Starts (UTC, optional)</span>
          <input type="datetime-local" value={startsAt} onChange={e => setStartsAt(e.target.value)}
            className="mt-1.5 w-full border border-border rounded-xl px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent" />
          <span className="text-[11px] text-muted">Leave empty to start as soon as you save.</span>
        </label>
        <label className="block">
          <span className="text-[10px] font-mono text-muted uppercase tracking-widest">Ends (UTC)</span>
          <input type="datetime-local" value={endsAt} onChange={e => setEndsAt(e.target.value)}
            className="mt-1.5 w-full border border-border rounded-xl px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent" />
          <span className="text-[11px] text-muted">
            The offer stops at exactly this minute. For &ldquo;ends 6 Nov&rdquo; use 2026-11-06 23:59 (that is 02:59 on 7 Nov in Nairobi — say so in announcements).
          </span>
        </label>
        <div>
          <button onClick={save} disabled={busy}
            className="bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-medium disabled:opacity-60">
            {busy ? 'Saving…' : promo ? 'Save changes' : 'Create offer'}
          </button>
        </div>
      </div>
    </div>
  )
}
