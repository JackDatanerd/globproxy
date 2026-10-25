'use client'
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { apiFetch, apiJson } from '@/lib/clientApi'
import { PLANS, resolveOrder, CUSTOM_MIN_GB, CUSTOM_MAX_GB } from '@/lib/plans'
import { formatUsd } from '@/lib/format'
import { validThreshold, validCap } from '@/lib/rechargeRules'

type Card = { brand: string | null; last4: string | null; exp_month: string | null; exp_year: string | null }
type Settings = {
  enabled: boolean; threshold_gb: number; plan_slug: string; gb: number | null
  monthly_cap_usd: number; consecutive_failures: number; disabled_reason: string | null
}

const REASONS: Record<string, string> = {
  card_removed: 'You removed the saved card.',
  no_saved_card: 'No saved card was found.',
  invalid_plan: 'The selected top-up is no longer available.',
  account_closed: 'The account was closed.',
}
const reasonText = (r: string | null) => !r ? null : r.startsWith('payment_failed') ? 'The last few charges to your card did not go through.' : (REASONS[r] ?? null)

// Billing → Auto-recharge. Keeps an account topped up: when unassigned bandwidth drops below
// the threshold the chosen amount is bought on the saved card, never more than the 30-day
// limit. The card is saved at a checkout where "Save this card for auto-recharge" was ticked.
export default function AutoRechargePanel() {
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [card, setCard] = useState<Card | null>(null)
  const [saving, setSaving] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [threshold, setThreshold] = useState('5')
  const [choice, setChoice] = useState('starter')
  const [customGb, setCustomGb] = useState('25')
  const [cap, setCap] = useState('100')
  const [why, setWhy] = useState<string | null>(null)
  const [usage, setUsage] = useState<{ spent_30d_usd: number; last_charge_at: string | null } | null>(null)
  const [failures, setFailures] = useState(0)

  async function load() {
    try {
      const d = await apiFetch('/api/dashboard/billing/auto-recharge')
      setCard(d.card ?? null)
      setUsage(d.usage ?? null)
      setFailures(Number(d.settings?.consecutive_failures ?? 0))
      const s: Settings = d.settings
      setEnabled(!!s.enabled); setThreshold(String(s.threshold_gb)); setCap(String(s.monthly_cap_usd))
      setChoice(s.plan_slug); if (s.gb) setCustomGb(String(s.gb))
      setWhy(!s.enabled ? reasonText(s.disabled_reason) : null)
      setLoaded(true)
    } catch (err: any) {
      if (err?.code !== 'mfa_required') setLoadFailed(true)
    }
  }
  useEffect(() => { load() }, [])

  const quote = resolveOrder(choice, choice === 'custom' ? Number(customGb) : undefined)

  async function turnOff() {
    // Independent of the form fields: switching the rule off must work even
    // while a field holds something invalid.
    setSaving(true)
    try {
      await apiJson('PUT', '/api/dashboard/billing/auto-recharge', { enabled: false })
      setEnabled(false); setWhy(null)
      toast.success('Auto-recharge is off.')
    } catch (err: any) {
      if (err?.code !== 'mfa_required') toast.error(err?.message || 'Could not switch off auto-recharge')
    }
    setSaving(false)
  }

  async function save(nextEnabled: boolean) {
    // Same rules as the server (lib/rechargeRules), so a typo is caught here with a clear message.
    if (!validThreshold(Number(threshold))) { toast.error('Choose a threshold between 1 and 500 GB.'); return }
    if (!validCap(Number(cap))) { toast.error('Choose a 30-day limit between $1 and $5,000.'); return }
    if (!quote) { toast.error(`Choose a plan, or a whole number of GB from ${CUSTOM_MIN_GB} to ${CUSTOM_MAX_GB}.`); return }
    setSaving(true)
    try {
      await apiJson('PUT', '/api/dashboard/billing/auto-recharge', {
        enabled: nextEnabled, threshold_gb: Number(threshold), monthly_cap_usd: Number(cap),
        plan: quote.slug, ...(quote.custom ? { gb: quote.gb } : {}),
      })
      setEnabled(nextEnabled); setWhy(null)
      toast.success(nextEnabled ? 'Auto-recharge is on.' : 'Settings saved — auto-recharge is off.')
    } catch (err: any) {
      if (err?.code !== 'mfa_required') toast.error(err?.message || 'Could not save auto-recharge')
    }
    setSaving(false)
  }

  async function removeCard() {
    if (!window.confirm('Remove your saved card? Auto-recharge will switch off.')) return
    setSaving(true)
    try {
      await apiJson('DELETE', '/api/dashboard/billing/auto-recharge')
      setCard(null); setEnabled(false)
      toast.success('Card removed.')
    } catch (err: any) {
      if (err?.code !== 'mfa_required') toast.error(err?.message || 'Could not remove the card')
    }
    setSaving(false)
  }

  const input = 'mt-1.5 w-full border border-border rounded-xl px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent'
  const label = 'text-[10px] font-mono text-muted uppercase tracking-widest'

  return (
    <div className="bg-white border border-border rounded-xl mb-8">
      <button onClick={() => setOpen(o => !o)} aria-expanded={open} className="w-full flex items-center justify-between px-6 py-4 text-left">
        <div>
          <h2 className="font-display font-bold text-base text-ink">
            Auto-recharge {loaded && <span className={`ml-2 text-[10px] font-mono px-2 py-0.5 rounded-full ${enabled ? 'bg-accent2-light text-accent2' : 'bg-surface text-muted'}`}>{enabled ? 'ON' : 'OFF'}</span>}
          </h2>
          <p className="text-xs text-muted mt-0.5">Never run dry mid-job: top up automatically from a saved card.</p>
        </div>
        <span className="text-muted text-sm">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="px-6 pb-6 border-t border-border pt-4">
          {loadFailed ? (
            <p className="text-sm text-muted">We couldn&apos;t load your auto-recharge settings. <button onClick={() => { setLoadFailed(false); load() }} className="text-accent hover:underline">Try again</button></p>
          ) : !loaded ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : !card ? (
            <p className="text-sm text-ink2">
              No card saved yet. Next time you <a href="/dashboard/buy" className="text-accent hover:underline">buy bandwidth by card</a>, tick
              &ldquo;Save this card for auto-recharge&rdquo;, then come back here to turn it on.
            </p>
          ) : (
            <div className="grid gap-4 max-w-lg">
              {why && <p className="text-sm text-amber-700 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">Auto-recharge was switched off. {why}</p>}
              <div className="flex items-center justify-between text-sm text-ink2">
                <span>Saved card: <span className="font-mono">{card.brand ?? 'Card'} •••• {card.last4 ?? '????'}</span>{card.exp_month && card.exp_year ? <span className="text-muted"> · exp {card.exp_month}/{card.exp_year}</span> : null}</span>
                <button onClick={removeCard} disabled={saving} className="text-xs text-muted hover:text-red-500 underline disabled:opacity-50">Remove card</button>
              </div>
              <label className="block">
                <span className={label}>When unassigned bandwidth drops below (GB)</span>
                <input value={threshold} onChange={e => setThreshold(e.target.value)} inputMode="numeric" className={input} />
              </label>
              <label className="block">
                <span className={label}>Buy</span>
                <select value={choice} onChange={e => setChoice(e.target.value)} className={input}>
                  {PLANS.map(p => <option key={p.slug} value={p.slug}>{p.name} — {p.gb} GB · {formatUsd(p.total)}</option>)}
                  <option value="custom">Custom amount…</option>
                </select>
                {choice === 'custom' && (
                  <input value={customGb} onChange={e => setCustomGb(e.target.value)} inputMode="numeric" aria-label="GB to buy each time" className={input} />
                )}
                <span className="text-[11px] text-muted mt-1 block">{quote ? `Each top-up: ${quote.gb} GB for ${formatUsd(quote.total)}` : 'Enter a valid amount.'}</span>
              </label>
              <label className="block">
                <span className={label}>Never spend more than (USD per 30 days)</span>
                <input value={cap} onChange={e => setCap(e.target.value)} inputMode="decimal" className={input} />
                {usage && (
                  <span className="text-[11px] text-muted mt-1 block">
                    Auto-recharge has spent {formatUsd(usage.spent_30d_usd)} in the last 30 days
                    {Number(cap) > 0 ? ` (${Math.min(100, Math.round((usage.spent_30d_usd / Number(cap)) * 100))}% of this limit)` : ''}
                    {usage.last_charge_at ? ` · last charge ${new Date(usage.last_charge_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}` : ' · no charges yet'}.
                  </span>
                )}
                {enabled && failures > 0 && (
                  <span className="text-[11px] text-amber-700 mt-1 block">{failures} recent charge{failures === 1 ? '' : 's'} to this card did not go through. It switches off automatically if this keeps happening.</span>
                )}
              </label>
              <div className="flex items-center gap-3">
                <button onClick={() => save(true)} disabled={saving} className="bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-medium disabled:opacity-60">
                  {saving ? 'Saving…' : enabled ? 'Update' : 'Turn on'}
                </button>
                {enabled
                  ? <button onClick={turnOff} disabled={saving} className="text-sm text-ink2 border border-border px-4 py-2.5 rounded-xl disabled:opacity-60">Turn off</button>
                  : <button onClick={() => save(false)} disabled={saving} className="text-sm text-ink2 border border-border px-4 py-2.5 rounded-xl disabled:opacity-60">Save without turning on</button>}
              </div>
              <p className="text-[11px] text-muted">By turning this on you authorise GlobProxy to charge the saved card whenever the rule above applies. You get the normal invoice and e-mail for every top-up, and you can turn it off or remove the card at any time.</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
