'use client'
import { useState } from 'react'
import { lastCompletedCycle, formatCycleLabel, currentAccruingCycle, cycleIsPayable } from '@/lib/payoutCycle'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

export default function RunPayoutCycleButton() {
  const defaultCycle = lastCompletedCycle()
  const [cycleStart, setCycleStart] = useState(defaultCycle.cycleStart)
  const [cycleEnd, setCycleEnd] = useState(defaultCycle.cycleEnd)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)

  async function handle() {
    // Same rule the server enforces: the cycle containing "To" is payable from the 20th / the 5th.
    const payableFrom = /^\d{4}-\d{2}-\d{2}$/.test(cycleEnd) ? currentAccruingCycle(new Date(`${cycleEnd}T00:00:00Z`)).payableFrom : null
    const early = payableFrom ? !cycleIsPayable({ payableFrom }) : false
    const msg = early
      ? `This cycle is not payable until ${payableFrom} (UTC). Running it now pays affiliates EARLY, before late refunds can land. Run it anyway?`
      : `Run the payout cycle for ${cycleStart} → ${cycleEnd}? This creates payout records for every eligible affiliate (including earlier balances that were held back).`
    if (!confirm(msg)) return
    setLoading(true)
    const { ok, data } = await adminPost('/api/admin/run-payout-cycle', { cycleStart, cycleEnd, payEarly: early })
    setLoading(false)
    if (!ok) { toast.error(data.error ?? 'Failed to run payout cycle'); return }
    const s = data.summary
    const rolled = s.heldRecentMethod + s.noPayoutMethod + s.belowMinimum
    toast.success(`${s.created} payout${s.created === 1 ? '' : 's'} created · ${rolled} rolled forward${s.ineligible ? ` · ${s.ineligible} ineligible (suspended/deleted)` : ''}`)
    window.location.reload()
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-xs font-mono px-4 py-2 rounded-lg border border-accent2 bg-accent2 text-white hover:opacity-90 transition-all"
      >
        Run payout cycle
      </button>
    )
  }

  return (
    <div className="bg-white border border-border rounded-xl p-5">
      <div className="text-sm font-medium text-ink mb-1">Run payout cycle</div>
      <div className="text-xs text-muted mb-3">
        Defaults to the most recently completed cycle ({formatCycleLabel(defaultCycle)}). Safe to re-run — commissions already batched into a payout are never claimed twice. Balances held back from earlier cycles (no payout method, security hold, below the minimum) are picked up automatically.
      </div>
      <div className="flex gap-2 items-end mb-3">
        <div>
          <label className="text-[10px] font-mono text-muted uppercase tracking-wider">From</label>
          <input type="date" value={cycleStart} onChange={(e) => setCycleStart(e.target.value)}
            className="block mt-1 text-sm text-ink bg-surface border border-border rounded-lg px-3 py-1.5" />
        </div>
        <div>
          <label className="text-[10px] font-mono text-muted uppercase tracking-wider">To</label>
          <input type="date" value={cycleEnd} onChange={(e) => setCycleEnd(e.target.value)}
            className="block mt-1 text-sm text-ink bg-surface border border-border rounded-lg px-3 py-1.5" />
        </div>
      </div>
      <div className="flex gap-2">
        <button onClick={handle} disabled={loading}
          className="text-xs font-mono px-4 py-2 rounded-lg border border-accent2 bg-accent2 text-white hover:opacity-90 transition-all disabled:opacity-50">
          {loading ? 'Running…' : 'Run this cycle'}
        </button>
        <button onClick={() => setOpen(false)} className="text-xs font-mono px-4 py-2 rounded-lg border border-border text-muted">
          Cancel
        </button>
      </div>
    </div>
  )
}
