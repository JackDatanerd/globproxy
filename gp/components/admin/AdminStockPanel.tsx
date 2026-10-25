'use client'
import { useState, useEffect, useCallback } from 'react'
import toast from 'react-hot-toast'
import { formatGb, formatPct } from '@/lib/format'
import { adminGet, adminPost } from '@/lib/adminFetch'

type Stock = {
  available_gb?: number; total_gb?: number; total_allocated_gb?: number; total_used_gb?: number
  exposure_gb?: number; covered?: boolean; last_synced?: string | null
  unallocated_balances_gb?: number; pending_allocated_gb?: number; paused_resume_gb?: number
}

// Loads and saves through /api/admin/stock-settings (MFA-gated, audited) —
// never straight from the browser. Nothing is drawn as "critical" until real
// numbers have arrived: the old placeholder of 0 GB flashed a red alert on
// every page load, and stayed red for good if the read failed.
export default function AdminStockPanel() {
  const [stock, setStock] = useState<Stock | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [customEnabled, setCustomEnabled] = useState(false)
  const [threshold, setThreshold] = useState('10')
  const [defaultThreshold, setDefaultThreshold] = useState(10)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoadError(null)
    const { ok, data } = await adminGet<any>('/api/admin/stock-settings')
    if (!ok) { setLoadError(data.error ?? 'Could not load stock settings.'); return }
    setStock(data.stock ?? {})
    setCustomEnabled(!!data.custom_threshold_enabled)
    setThreshold(String(data.threshold ?? data.default_threshold ?? 10))
    setDefaultThreshold(Number(data.default_threshold ?? 10))
  }, [])

  useEffect(() => { load() }, [load])

  async function syncStock() {
    setSyncing(true)
    const { ok, data } = await adminPost('/api/admin/sync-stock')
    if (!ok) toast.error(data.error ?? 'Sync failed')
    else { setStock((data as any).stock); setLoadError(null); toast.success('Stock synced') }
    setSyncing(false)
  }

  async function saveSettings() {
    const t = Number(threshold)
    if (!Number.isFinite(t) || t < 1) { toast.error('Alert threshold must be at least 1 GB'); return }
    setSaving(true)
    const { ok, data } = await adminPost('/api/admin/stock-settings', { enabled: customEnabled, threshold: t })
    setSaving(false)
    if (!ok) toast.error(data.error ?? 'Could not save settings')
    else toast.success('Settings saved')
  }

  if (loadError) {
    return (
      <div className="bg-white border border-border rounded-xl p-6">
        <h2 className="font-display font-bold text-base text-ink mb-3">Upstream Stock</h2>
        <p className="text-sm text-red-600 mb-3">{loadError}</p>
        <button onClick={load} className="text-xs font-mono text-accent border border-accent/30 px-3 py-1.5 rounded-lg hover:bg-accent-light">Retry</button>
      </div>
    )
  }
  if (!stock) {
    return (
      <div className="bg-white border border-border rounded-xl p-6">
        <h2 className="font-display font-bold text-base text-ink mb-3">Upstream Stock</h2>
        <p className="text-sm text-muted">Loading…</p>
      </div>
    )
  }

  const neverSynced = stock.available_gb == null
  const effectiveThreshold = customEnabled && Number(threshold) >= 1 ? Number(threshold) : defaultThreshold
  const avail = stock.available_gb ?? 0
  const total = stock.total_gb ?? 0
  const pct = total > 0 ? (avail / total) * 100 : 0
  const isCritical = !neverSynced && avail <= effectiveThreshold
  const isWarn = !neverSynced && avail <= effectiveThreshold * 3

  return (
    <div className="bg-white border border-border rounded-xl p-6">
      <div className="flex items-center justify-between mb-5">
        <h2 className="font-display font-bold text-base text-ink">Upstream Stock</h2>
        <button onClick={syncStock} disabled={syncing} className="text-xs font-mono text-muted border border-border px-3 py-1.5 rounded-lg hover:text-ink transition-all disabled:opacity-50">
          {syncing ? 'Syncing...' : '↻ Sync'}
        </button>
      </div>
      <div className={`rounded-xl p-4 mb-5 ${isCritical ? 'bg-red-50 border border-red-200' : isWarn ? 'bg-yellow-50 border border-yellow-100' : 'bg-surface border border-border'}`}>
        <div className="flex justify-between items-end mb-3">
          <div>
            <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-1">Available stock</div>
            {neverSynced
              ? <div className="font-display text-xl font-bold text-muted">Not synced yet</div>
              : <div className={`font-display text-4xl font-bold ${isCritical ? 'text-red-500' : isWarn ? 'text-yellow-600' : 'text-accent'}`}>{formatGb(avail)} GB</div>}
          </div>
          {isCritical && <div className="bg-red-100 text-red-600 text-xs font-mono px-3 py-1.5 rounded-full animate-pulse">⚠ Critical</div>}
          {isWarn && !isCritical && <div className="bg-yellow-100 text-yellow-700 text-xs font-mono px-3 py-1.5 rounded-full">Low stock</div>}
        </div>
        {!neverSynced && (
          <>
            <div className="bg-white/70 rounded-full h-2.5 overflow-hidden mb-1.5">
              <div className={`h-full rounded-full ${isCritical ? 'bg-red-400' : isWarn ? 'bg-yellow-400' : 'bg-accent'}`} style={{ width: `${Math.min(pct, 100)}%` }} />
            </div>
            <div className="flex justify-between text-[11px] font-mono text-muted">
              <span>{formatPct(avail, total)}% remaining</span>
              <span>Total: {formatGb(total)} GB</span>
            </div>
          </>
        )}
        {stock.last_synced && <div className="text-[10px] font-mono text-muted mt-2">Synced: {new Date(stock.last_synced).toLocaleString()}</div>}
      </div>

      {/* Sold vs. stock — the number that actually matters for a usage-based
          model. total_allocated_gb / total_used_gb / exposure_gb only exist
          after the first sync following this deploy. */}
      <div className={`rounded-xl p-4 mb-5 border ${stock.covered === false ? 'bg-red-50 border-red-200' : 'bg-surface border-border'}`}>
        <div className="flex items-center justify-between mb-3">
          <div className="text-[10px] font-mono text-muted uppercase tracking-widest">Sold vs. stock (usage-based exposure)</div>
          {stock.covered === false && (
            <div className="bg-red-100 text-red-600 text-[10px] font-mono px-2.5 py-1 rounded-full">⚠ Not covered</div>
          )}
        </div>
        <div className="grid grid-cols-3 gap-3 text-center">
          <div>
            <div className="font-display text-xl font-bold text-ink">{formatGb(stock.total_allocated_gb)}</div>
            <div className="text-[10px] font-mono text-muted mt-0.5">Allocated (sold)</div>
          </div>
          <div>
            <div className="font-display text-xl font-bold text-ink">{formatGb(stock.total_used_gb)}</div>
            <div className="text-[10px] font-mono text-muted mt-0.5">Actually used</div>
          </div>
          <div>
            <div className={`font-display text-xl font-bold ${stock.covered === false ? 'text-red-500' : 'text-ink'}`}>{formatGb(stock.exposure_gb)}</div>
            <div className="text-[10px] font-mono text-muted mt-0.5">Exposure (unallocated + pending + paused)</div>
          </div>
        </div>
        <p className="text-[10px] text-muted mt-3 font-light leading-relaxed">
          Exposure = customer balance not yet allocated to a session ({formatGb(stock.unallocated_balances_gb ?? 0)}) + sessions
          waiting to be provisioned ({formatGb(stock.pending_allocated_gb ?? 0)}) + unused GB in sessions customers have paused ({formatGb(stock.paused_resume_gb ?? 0)} — returned to the supplier&apos;s pool while paused, taken back on resume) — what you&apos;d still have to carve out of the supplier&apos;s
          available stock. GB already allocated to live sessions is already deducted from Available by the supplier, so it isn&apos;t counted again.
          {stock.covered === false
            ? ' Current stock is below this — you are exposed if customers allocate it all at once.'
            : ' Current stock covers this.'}
        </p>
      </div>

      <div className="mb-5 p-4 bg-surface border border-border rounded-xl">
        <div className="text-xs font-medium text-ink mb-1">Reloading stock</div>
        <p className="text-[11px] text-muted font-light leading-relaxed">
          The supplier&apos;s reseller API has no purchase endpoint, so stock is topped up in the supplier dashboard and then picked up here with <span className="font-mono">↻ Sync</span>.
        </p>
      </div>

      <div className="p-4 border border-border rounded-xl">
        <div className="text-xs font-medium text-ink mb-1">Low-stock email alerts</div>
        <p className="text-[11px] text-muted font-light leading-relaxed mb-3">
          Alerts are always on — you&apos;ll be emailed when available stock drops below {formatGb(effectiveThreshold)} GB
          {customEnabled ? ' (your custom threshold)' : ` (the default); switch on a custom threshold to change it`}.
        </p>
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs text-ink">Use a custom threshold</div>
          <button onClick={() => setCustomEnabled(!customEnabled)} aria-pressed={customEnabled}
            className={`relative w-10 h-5 rounded-full transition-all ${customEnabled ? 'bg-accent2' : 'bg-border'}`}>
            <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${customEnabled ? 'left-5' : 'left-0.5'}`} />
          </button>
        </div>
        {customEnabled && (
          <div className="flex items-center gap-3 mb-3">
            <label className="text-xs text-muted w-28">Alert threshold</label>
            <input type="number" value={threshold} onChange={e => setThreshold(e.target.value)} min={1}
              className="w-24 bg-white border border-border px-2.5 py-1.5 rounded-lg text-sm font-mono focus:outline-none focus:border-accent" />
            <span className="text-xs text-muted">GB remaining</span>
          </div>
        )}
        <button onClick={saveSettings} disabled={saving} className="text-xs font-mono text-accent border border-accent/30 px-3 py-1.5 rounded-lg hover:bg-accent-light transition-all disabled:opacity-50">{saving ? 'Saving…' : 'Save settings'}</button>
      </div>
    </div>
  )
}
