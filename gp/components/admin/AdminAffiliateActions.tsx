'use client'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'

// Same Bearer-token pattern as AdminResellerActions.tsx. 'markPaid' takes
// a payoutId — a whole cycle's payout to one affiliate, not a single
// commission (see migration 0034: affiliate_payouts is the batch, not
// affiliate_commissions). Kept as one component with a discriminated
// prop shape rather than a separate file, since the fetch/toast/reload
// plumbing is identical either way.
type Props =
  | { userId: string; action: 'approve' | 'reject'; payoutId?: never }
  | { payoutId: string; action: 'markPaid'; userId?: never }

export default function AdminAffiliateActions(props: Props) {
  const [loading, setLoading] = useState(false)

  async function handle() {
    setLoading(true)
    const { data: { session } } = await createClient().auth.getSession()
    const authHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` }

    let res: Response
    if (props.action === 'approve') {
      res = await fetch('/api/admin/approve-affiliate', {
        method: 'POST', headers: authHeaders, body: JSON.stringify({ userId: props.userId }),
      })
    } else if (props.action === 'reject') {
      res = await fetch('/api/admin/reject-affiliate', {
        method: 'POST', headers: authHeaders, body: JSON.stringify({ userId: props.userId }),
      })
    } else {
      res = await fetch('/api/admin/mark-payout-paid', {
        method: 'POST', headers: authHeaders, body: JSON.stringify({ payoutId: props.payoutId }),
      })
    }

    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.error) {
      toast.error(data.error ?? 'Action failed')
    } else {
      toast.success(
        props.action === 'approve' ? 'Affiliate approved' : props.action === 'reject' ? 'Application rejected' : 'Marked as paid'
      )
      window.location.reload()
    }
    setLoading(false)
  }

  const label = loading ? '...' : props.action === 'approve' ? 'Approve' : props.action === 'reject' ? 'Reject' : 'Mark paid'

  return (
    <button
      onClick={handle}
      disabled={loading}
      className={`text-xs font-mono px-3 py-1.5 rounded-lg border transition-all disabled:opacity-50 ${
        props.action === 'reject'
          ? 'border-red-200 text-red-400 hover:bg-red-50'
          : 'bg-accent2 text-white border-accent2 hover:opacity-90'
      }`}
    >
      {label}
    </button>
  )
}
