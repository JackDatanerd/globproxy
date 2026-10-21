'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

export default function MpesaSettings({
  enabled, markupPct, manualRate, live,
}: {
  enabled: boolean
  markupPct: number
  manualRate: number | null
  // What a customer would be quoted right now (null = M-Pesa unavailable).
  live: { rate: number; market: number; source: string; asOf: string | null } | null
}) {
  const [on, setOn] = useState(enabled)
  const [markup, setMarkup] = useState(String(markupPct))
  const [manual, setManual] = useState(manualRate != null ? String(manualRate) : '')
  const [saving, setSaving] = useState(false)

  async function save(extra: Record<string, unknown> = {}) {
    setSaving(true)
    const { ok, data } = await adminPost('/api/admin/mpesa-settings', {
      enabled: on,
      // A cleared field leaves the stored markup alone (Number('') is 0, which would
      // silently remove the markup).
      ...(markup.trim() === '' ? {} : { markupPct: Number(markup) }),
      manualRate: manual.trim() === '' ? null : Number(manual),
      ...extra,
    })
    setSaving(false)
    if (!ok) { toast.error(data.error ?? 'Failed to save'); return }
    toast.success(extra.refresh ? 'Rate cache cleared — the next checkout fetches a fresh rate' : 'M-Pesa settings saved')
    window.location.reload()
  }

  return (
    <div className="bg-white border border-border rounded-xl p-6 mt-5">
      <h2 className="font-display font-bold text-base text-ink mb-1">M-Pesa checkout (KES)</h2>
      <p className="text-xs text-muted font-light mb-4">
        Customers see USD prices; M-Pesa is charged in shillings at the market rate plus your markup, locked when they place the order.
        The market rate is fetched automatically and cached for 6 hours.
      </p>

      <div className="bg-surface border border-border rounded-lg p-4 mb-4 text-sm">
        {live ? (
          <>
            <div className="text-ink">Customers are quoted <span className="font-mono font-semibold">1 USD = {live.rate.toFixed(2)} KES</span></div>
            <div className="text-[11px] font-mono text-muted mt-1">
              market {live.market.toFixed(2)} + {markupPct}% markup · source: {live.source}{live.asOf ? ` · fetched ${new Date(live.asOf).toLocaleString('en-GB')}` : ''}
            </div>
          </>
        ) : (
          <div className="text-amber-700">M-Pesa is currently <strong>unavailable to customers</strong> — {enabled ? 'no live or fallback rate could be obtained. Set a manual fallback rate below.' : 'it is switched off.'}</div>
        )}
      </div>

      <div className="grid gap-4 max-w-md">
        <label className="flex items-center gap-3 text-sm text-ink">
          <input type="checkbox" checked={on} onChange={e => setOn(e.target.checked)} />
          Offer M-Pesa at checkout
        </label>
        <label className="block">
          <span className="text-[10px] font-mono text-muted uppercase tracking-widest">Markup over market rate (%)</span>
          <input value={markup} onChange={e => setMarkup(e.target.value)} inputMode="decimal"
            className="mt-1.5 w-full border border-border rounded-xl px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent" />
          <span className="text-[11px] text-muted">0–10. Covers the spread and rate drift between quote and settlement.</span>
        </label>
        <label className="block">
          <span className="text-[10px] font-mono text-muted uppercase tracking-widest">Manual fallback rate (KES per USD, optional)</span>
          <input value={manual} onChange={e => setManual(e.target.value)} inputMode="decimal" placeholder="e.g. 129"
            className="mt-1.5 w-full border border-border rounded-xl px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent" />
          <span className="text-[11px] text-muted">Used only if the live feeds are down and there is no cached rate under 72 hours old.</span>
        </label>
        <div className="flex gap-3">
          <button onClick={() => save()} disabled={saving}
            className="bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-medium disabled:opacity-60">{saving ? 'Saving…' : 'Save'}</button>
          <button onClick={() => save({ refresh: true })} disabled={saving}
            className="border border-border px-5 py-2.5 rounded-xl text-sm text-ink disabled:opacity-60">Refresh rate now</button>
        </div>
      </div>
    </div>
  )
}
