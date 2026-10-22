'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

const btn = 'text-[11px] font-mono px-2.5 py-1 rounded-lg border disabled:opacity-50'

// Re-verify an uncredited order with Paystack and credit it if the money really
// arrived (api/admin/verify-order). A mismatch is shown with its reason and can be
// credited anyway only after a second, explicit confirmation with a reason.
export function AdminVerifyOrderButton({ orderId, email }: { orderId: string; email: string }) {
  const [loading, setLoading] = useState(false)

  async function verify() {
    if (!confirm(`Check this order with Paystack for ${email} and credit it if the payment is confirmed?`)) return
    setLoading(true)
    let { ok, data } = await adminPost('/api/admin/verify-order', { orderId })
    if (!ok && data.can_override) {
      const reason = window.prompt(`${data.error}\n\nTo credit it anyway, type the reason (kept in the audit log), or cancel:`, '')
      if (reason && reason.trim().length >= 3) {
        ;({ ok, data } = await adminPost('/api/admin/verify-order', { orderId, override: true, reason }))
      } else {
        setLoading(false)
        return
      }
    }
    setLoading(false)
    if (!ok) { toast.error(data.error ?? 'Could not verify the order'); return }
    toast.success(data.status === 'already_credited' ? 'The order was already credited.' : 'Payment confirmed — order credited.')
    window.location.reload()
  }

  return (
    <button onClick={verify} disabled={loading} className={`${btn} text-accent border-accent/30 hover:bg-accent-light`}>
      {loading ? '…' : 'Verify & credit'}
    </button>
  )
}

// Settle a chargeback (api/admin/dispute-outcome).
export function AdminDisputeButtons({ orderId, email }: { orderId: string; email: string }) {
  const [loading, setLoading] = useState(false)

  async function settle(outcome: 'lost' | 'won') {
    const reason = window.prompt(
      outcome === 'lost'
        ? `Dispute LOST for ${email}.\nThe proportional bandwidth that is not already allocated to a session is taken back and a credit note is issued.\n\nReason (kept in the audit log):`
        : `Dispute WON for ${email}.\n\nReason / reference (kept in the audit log):`, '')
    if (reason === null) return
    if (reason.trim().length < 3) { toast.error('A reason is required'); return }
    setLoading(true)
    const { ok, data } = await adminPost('/api/admin/dispute-outcome', { orderId, outcome, reason })
    setLoading(false)
    if (!ok) { toast.error(data.error ?? 'Could not record the outcome'); return }
    toast.success(outcome === 'lost'
      ? `Recorded as lost — ${Number(data.gb_clawed ?? 0).toFixed(2)} GB taken back${Number(data.gb_not_recoverable) > 0 ? ` (${Number(data.gb_not_recoverable).toFixed(2)} GB was already in use)` : ''}.`
      : 'Recorded as won.', { duration: 8000 })
    window.location.reload()
  }

  return (
    <span className="inline-flex gap-1.5">
      <button onClick={() => settle('lost')} disabled={loading} className={`${btn} text-red-600 border-red-200 hover:bg-red-50`}>Dispute lost</button>
      <button onClick={() => settle('won')} disabled={loading} className={`${btn} text-ink2 border-border hover:border-ink2`}>Dispute won</button>
    </span>
  )
}

// Decline a customer's refund request (api/admin/refund-request). Approving is the
// regular Refund button.
export function AdminDeclineRequestButton({ requestId, email }: { requestId: string; email: string }) {
  const [loading, setLoading] = useState(false)

  async function decline() {
    const note = window.prompt(`Decline the refund request from ${email}.\nMessage to the customer (optional — it is included in the e-mail):`, '')
    if (note === null) return
    setLoading(true)
    const { ok, data } = await adminPost('/api/admin/refund-request', { requestId, note })
    setLoading(false)
    if (!ok) { toast.error(data.error ?? 'Could not decline the request'); return }
    toast.success('Request declined — the customer has been told.')
    window.location.reload()
  }

  return (
    <button onClick={decline} disabled={loading} className={`${btn} text-ink2 border-border hover:border-ink2`}>
      {loading ? '…' : 'Decline request'}
    </button>
  )
}
