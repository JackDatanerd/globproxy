'use client'

import { useState } from 'react'
import toast from 'react-hot-toast'
import { apiJson } from '@/lib/clientApi'

// "E-mail me when my stock drops below N GB". Empty / 0 turns it off.
export default function ResellerStockAlert({ initialGb }: { initialGb: number | null }) {
  const [value, setValue] = useState(initialGb ? String(initialGb) : '')
  const [saved, setSaved] = useState(initialGb ? String(initialGb) : '')
  const [busy, setBusy] = useState(false)

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const d = await apiJson('POST', '/api/reseller/settings', { low_stock_gb: value.trim() === '' ? null : value.trim() })
      const v = d.low_stock_gb ? String(d.low_stock_gb) : ''
      setValue(v); setSaved(v)
      toast.success(v ? `You'll be e-mailed when stock falls below ${v} GB` : 'Low-stock alert turned off')
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="bg-white border border-border rounded-xl p-4 mb-6 flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-ink">Low-stock alert</div>
        <div className="text-[11px] text-muted mt-0.5">E-mail me once when my available stock falls below this many GB. Leave empty to switch it off.</div>
      </div>
      <input type="number" min={0} step="any" value={value} onChange={e => setValue(e.target.value)} placeholder="e.g. 50"
        className="w-28 bg-surface border border-border px-3 py-2 rounded-lg text-sm focus:outline-none focus:border-accent" />
      <button type="submit" disabled={busy || value === saved}
        className="text-xs font-mono px-3 py-2 rounded-lg border border-border text-ink hover:bg-surface disabled:opacity-50">
        {busy ? 'Saving…' : 'Save'}
      </button>
    </form>
  )
}
