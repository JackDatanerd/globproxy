'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

// Starts a Paystack refund for one order (api/admin/refund-order). Nothing
// changes locally until Paystack confirms: the refund.processed webhook then
// takes the proportional bandwidth back, issues the credit note and emails
// the customer — so the order looks unchanged for a few minutes.
export default function AdminRefundButton({ orderId, remainingUsd, email }: { orderId: string; remainingUsd: number; email: string }) {
  const [loading, setLoading] = useState(false)

  async function refund() {
    const raw = window.prompt(
      `Refund ${email}.\nAmount in USD (leave blank for the full remaining $${remainingUsd.toFixed(2)}):`, ''
    )
    if (raw === null) return
    let amountUsd: number | undefined
    if (raw.trim() !== '') {
      amountUsd = Number(raw.trim())
      if (!Number.isFinite(amountUsd) || amountUsd < 0.01 || amountUsd > remainingUsd) {
        toast.error(`Enter an amount between $0.01 and $${remainingUsd.toFixed(2)}`); return
      }
    }
    const reason = window.prompt('Reason (required, kept in the audit log):')
    if (reason === null) return
    if (reason.trim().length < 3) { toast.error('A reason is required'); return }
    const shown = amountUsd ?? remainingUsd
    if (!confirm(`Refund $${shown.toFixed(2)} to ${email}?\n\nThe proportional bandwidth is taken back automatically (never below what is already allocated to sessions), and any affiliate commission on the order is reduced.`)) return

    setLoading(true)
    const { ok, data } = await adminPost('/api/admin/refund-order', { orderId, amountUsd, reason })
    setLoading(false)
    if (!ok) { toast.error(data.error ?? 'Refund failed'); return }
    toast.success('Refund requested — it shows on the order once Paystack confirms (usually within minutes).', { duration: 8000 })
  }

  return (
    <button onClick={refund} disabled={loading}
      className="text-[11px] font-mono text-red-600 border border-red-200 px-2.5 py-1 rounded-lg hover:bg-red-50 disabled:opacity-50">
      {loading ? '…' : 'Refund'}
    </button>
  )
}
