'use client'
import { useState } from 'react'
import AdminCsvButton from '@/components/admin/AdminCsvButton'

// Orders / refunds export for accounting: the Orders page's current filter plus
// an optional date range (by order date, UTC). Opens the same step-up download
// as the payout and audit exports.
export default function AdminOrdersExport({ status, q }: { status: string; q: string }) {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const params = new URLSearchParams()
  if (status) params.set('status', status)
  if (q) params.set('q', q)
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  const qs = params.toString()
  const input = 'bg-white border border-border px-2 py-1 rounded-lg text-xs font-mono focus:outline-none focus:border-accent'
  return (
    <div className="flex items-center gap-2 text-[10px] font-mono text-muted">
      <span>Export</span>
      <input type="date" value={from} onChange={e => setFrom(e.target.value)} className={input} aria-label="From date" />
      <span>→</span>
      <input type="date" value={to} onChange={e => setTo(e.target.value)} className={input} aria-label="To date" />
      <AdminCsvButton path={`/api/admin/orders-csv${qs ? `?${qs}` : ''}`} filename={`globproxy-orders${status ? '-' + status : ''}`} />
    </div>
  )
}
