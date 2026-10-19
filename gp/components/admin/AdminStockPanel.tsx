'use client'
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'
import { formatGb, formatPct } from '@/lib/format'
import { adminPost } from '@/lib/adminFetch'

export default function AdminStockPanel() {
  const [stock, setStock] = useState<any>({ available_gb:0, total_gb:0, total_allocated_gb:0, total_used_gb:0, exposure_gb:0, covered:true, last_synced:null })
  const [loading, setLoading] = useState(false)
  const [autoReload, setAutoReload] = useState(false)
  const [threshold, setThreshold] = useState(10)
  const [saving, setSaving] = useState(false)

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    const sb = createClient()
    const { data } = await sb.from('platform_settings').select('*').in('key',['geonode_stock','auto_reload_enabled','auto_reload_threshold_gb'])
    data?.forEach((s: any) => {
      if (s.key==='geonode_stock') { try { setStock(JSON.parse(s.value)) } catch {} }
      if (s.key==='auto_reload_enabled') setAutoReload(s.value==='true')
      if (s.key==='auto_reload_threshold_gb') setThreshold(Number(s.value))
    })
  }

  async function syncStock() {
    setLoading(true)
    const { ok, data } = await adminPost('/api/admin/sync-stock')
    if (!ok) toast.error(data.error ?? 'Sync failed')
    else { setStock((data as any).stock); toast.success('Stock synced') }
    setLoading(false)
  }

  // These writes happen from the browser (RLS: admins only). The results
  // were never inspected, so "Settings saved" showed even when the write
  // had been rejected.
  async function saveSettings() {
    if (!Number.isFinite(threshold) || threshold < 1) { toast.error('Alert threshold must be at least 1 GB'); return }
    setSaving(true)
    const sb = createClient()
    const results = await Promise.all([
      sb.from('platform_settings').upsert({key:'auto_reload_enabled',value:String(autoReload)},{onConflict:'key'}),
      sb.from('platform_settings').upsert({key:'auto_reload_threshold_gb',value:String(threshold)},{onConflict:'key'}),
    ])
    setSaving(false)
    const failed = results.find(r => r.error)
    if (failed?.error) toast.error(`Could not save settings: ${failed.error.message}`)
    else toast.success('Settings saved')
  }

  const avail = stock?.available_gb ?? 0
  const total = stock?.total_gb ?? 0
  const pct = total > 0 ? (avail / total) * 100 : 0
  const isCritical = avail <= threshold
  const isWarn = avail <= threshold * 3

  return (
    <div className="bg-white border border-border rounded-xl p-6">
      <div className="flex items-center justify-between mb-5">
        <h2 className="font-display font-bold text-base text-ink">Geonode Stock</h2>
        <button onClick={syncStock} disabled={loading} className="text-xs font-mono text-muted border border-border px-3 py-1.5 rounded-lg hover:text-ink transition-all disabled:opacity-50">
          {loading ? 'Syncing...' : '↻ Sync'}
        </button>
      </div>
      <div className={`rounded-xl p-4 mb-5 ${isCritical?'bg-red-50 border border-red-200':isWarn?'bg-yellow-50 border border-yellow-100':'bg-surface border border-border'}`}>
        <div className="flex justify-between items-end mb-3">
          <div>
            <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-1">Available stock</div>
            <div className={`font-display text-4xl font-bold ${isCritical?'text-red-500':isWarn?'text-yellow-600':'text-accent'}`}>{formatGb(avail)} GB</div>
          </div>
          {isCritical && <div className="bg-red-100 text-red-600 text-xs font-mono px-3 py-1.5 rounded-full animate-pulse">⚠ Critical</div>}
          {isWarn && !isCritical && <div className="bg-yellow-100 text-yellow-700 text-xs font-mono px-3 py-1.5 rounded-full">Low stock</div>}
        </div>
        <div className="bg-white/70 rounded-full h-2.5 overflow-hidden mb-1.5">
          <div className={`h-full rounded-full ${isCritical?'bg-red-400':isWarn?'bg-yellow-400':'bg-accent'}`} style={{width:`${Math.min(pct,100)}%`}} />
        </div>
        <div className="flex justify-between text-[11px] font-mono text-muted">
          <span>{formatPct(avail, total)}% remaining</span>
          <span>Total: {formatGb(total)} GB</span>
        </div>
        {stock?.last_synced && <div className="text-[10px] font-mono text-muted mt-2">Synced: {new Date(stock.last_synced).toLocaleString()}</div>}
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
            <div className="text-[10px] font-mono text-muted mt-0.5">Exposure</div>
          </div>
        </div>
        <p className="text-[10px] text-muted mt-3 font-light leading-relaxed">
          Exposure = allocated minus used — what you'd need in hand if every customer drew their full remaining allocation right now.
          {stock.covered === false
            ? ' Current stock is below this — you are exposed if customers draw down at once.'
            : ' Current stock covers this.'}
        </p>
      </div>

      <div className="mb-5 p-4 bg-surface border border-border rounded-xl">
        <div className="text-xs font-medium text-ink mb-1">Reloading stock</div>
        <p className="text-[11px] text-muted font-light leading-relaxed">
          Geonode's reseller API has no purchase endpoint, so stock is topped up in the Geonode dashboard and then picked up here with <span className="font-mono">↻ Sync</span>.
        </p>
      </div>

      <div className="p-4 border border-border rounded-xl">
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs font-medium text-ink">Low-stock email alerts</div>
          <button onClick={()=>setAutoReload(!autoReload)} className={`relative w-10 h-5 rounded-full transition-all ${autoReload?'bg-accent2':'bg-border'}`}>
            <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${autoReload?'left-5':'left-0.5'}`} />
          </button>
        </div>
        {autoReload && (
          <div className="flex flex-col gap-2.5 mb-3">
            <div className="flex items-center gap-3">
              <label className="text-xs text-muted w-28">Alert threshold</label>
              <input type="number" value={threshold} onChange={e=>setThreshold(+e.target.value)} min={1}
                className="w-20 bg-white border border-border px-2.5 py-1.5 rounded-lg text-sm font-mono focus:outline-none focus:border-accent" />
              <span className="text-xs text-muted">GB remaining</span>
            </div>
          </div>
        )}
        <button onClick={saveSettings} disabled={saving} className="text-xs font-mono text-accent border border-accent/30 px-3 py-1.5 rounded-lg hover:bg-accent-light transition-all disabled:opacity-50">{saving ? 'Saving…' : 'Save settings'}</button>
        <p className="text-[10px] text-muted mt-2 font-light">{autoReload?`Email alert when stock drops below ${threshold}GB.`:'Enable to receive low-stock alerts.'}</p>
      </div>
    </div>
  )
}
