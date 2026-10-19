'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

// One component, one discriminated prop shape, for every affiliate-side
// admin button. 'markPaid' takes a payoutId — a whole cycle's payout to one
// affiliate, not a single commission (affiliate_payouts is the batch).
type Props =
  | { userId: string; action: 'approve' | 'reject' | 'suspendAffiliate' | 'reinstateAffiliate' | 'grantVerifiedOperator' | 'revokeVerifiedOperator'; payoutId?: never }
  | { userId: string; action: 'editRates'; currentIntro: number; currentLifetime: number; payoutId?: never }
  | { payoutId: string; action: 'markPaid' | 'voidPayout'; amountUsd?: number; userId?: never }

// Prompts take whole percentages ("30"), the API takes fractions (0.30).
function askPercent(label: string, def: number): number | null {
  const raw = window.prompt(label, String(def))
  if (raw === null) return null
  const n = Number(raw.replace('%', '').trim())
  if (!Number.isFinite(n) || n < 0 || n > 100) { toast.error('Enter a percentage between 0 and 100'); return null }
  return n / 100
}

export default function AdminAffiliateActions(props: Props) {
  const [loading, setLoading] = useState(false)

  async function handle() {
    let path = ''
    let body: Record<string, unknown> = {}
    let success = ''

    switch (props.action) {
      case 'approve': {
        const intro = askPercent('Commission % for the first 90 days of each referral (default 30):', 30)
        if (intro === null) return
        const lifetime = askPercent('Commission % after the first 90 days (default 15):', 15)
        if (lifetime === null) return
        path = '/api/admin/approve-affiliate'; body = { userId: props.userId, introRate: intro, lifetimeRate: lifetime }; success = 'Affiliate approved'
        break
      }
      case 'reject':
        path = '/api/admin/reject-affiliate'; body = { userId: props.userId }; success = 'Application rejected'
        break
      case 'markPaid': {
        const amount = props.amountUsd != null ? ` of $${props.amountUsd.toFixed(2)}` : ''
        const ref = window.prompt(`Mark this payout${amount} as PAID.\n\nOnly continue once the money has actually been sent. Payment reference (txn hash / M-Pesa code — optional, shown to the affiliate):`, '')
        if (ref === null) return
        path = '/api/admin/mark-payout-paid'; body = { payoutId: props.payoutId, reference: ref }; success = 'Marked as paid'
        break
      }
      case 'voidPayout': {
        const amount = props.amountUsd != null ? ` of $${props.amountUsd.toFixed(2)}` : ''
        if (!confirm(`Void this pending payout${amount}?\n\nIts commissions go back to the affiliate's balance and the next payout run picks them up again. Do NOT void a payout you have already sent.`)) return
        const reason = window.prompt('Reason (required — recorded in the audit log):', '')
        if (!reason?.trim()) { if (reason !== null) toast.error('A reason is required'); return }
        path = '/api/admin/void-payout'; body = { payoutId: props.payoutId, reason }; success = 'Payout voided'
        break
      }
      case 'grantVerifiedOperator':
        if (!confirm('Make this affiliate a Verified Operator? Their rates rise to 40% / 20% (a higher existing rate is kept).')) return
        path = '/api/admin/grant-verified-operator'; body = { userId: props.userId }; success = 'Granted Verified Operator'
        break
      case 'revokeVerifiedOperator':
        if (!confirm('Revoke Verified Operator? Their rates go back to what they had before the upgrade.')) return
        path = '/api/admin/grant-verified-operator'; body = { userId: props.userId, revoke: true }; success = 'Verified Operator revoked'
        break
      case 'suspendAffiliate': {
        if (!confirm('Suspend this affiliate? New referrals stop earning commission and payouts are skipped until reinstated. Earned commissions are kept.')) return
        const reason = window.prompt('Reason (optional — included in the email to the affiliate):', '')
        if (reason === null) return
        path = '/api/admin/suspend-affiliate'; body = { userId: props.userId, action: 'suspend', reason }; success = 'Affiliate suspended'
        break
      }
      case 'reinstateAffiliate':
        path = '/api/admin/suspend-affiliate'; body = { userId: props.userId, action: 'reinstate' }; success = 'Affiliate reinstated'
        break
      case 'editRates': {
        const intro = askPercent('New commission % for the first 90 days:', Math.round(props.currentIntro * 100))
        if (intro === null) return
        const lifetime = askPercent('New commission % after the first 90 days:', Math.round(props.currentLifetime * 100))
        if (lifetime === null) return
        path = '/api/admin/set-affiliate-rates'; body = { userId: props.userId, introRate: intro, lifetimeRate: lifetime }; success = 'Rates updated'
        break
      }
    }

    setLoading(true)
    const { ok, data } = await adminPost(path, body)
    if (!ok) { toast.error(data.error ?? 'Action failed'); setLoading(false); return }
    toast.success(success)
    window.location.reload()
  }

  const danger = props.action === 'reject' || props.action === 'voidPayout' || props.action === 'revokeVerifiedOperator' || props.action === 'suspendAffiliate'
  const neutral = props.action === 'editRates'
  const label = loading ? '...'
    : props.action === 'approve' ? 'Approve'
    : props.action === 'reject' ? 'Reject'
    : props.action === 'markPaid' ? 'Mark paid'
    : props.action === 'voidPayout' ? 'Void'
    : props.action === 'grantVerifiedOperator' ? 'Make Verified Operator'
    : props.action === 'suspendAffiliate' ? 'Suspend'
    : props.action === 'reinstateAffiliate' ? 'Reinstate'
    : props.action === 'editRates' ? 'Edit rates'
    : 'Revoke'

  return (
    <button onClick={handle} disabled={loading}
      className={`text-xs font-mono px-3 py-1.5 rounded-lg border transition-all disabled:opacity-50 ${
        danger ? 'border-red-200 text-red-400 hover:bg-red-50'
        : neutral ? 'border-border text-ink2 hover:border-ink2 hover:text-ink'
        : 'bg-accent2 text-white border-accent2 hover:opacity-90'
      }`}>
      {label}
    </button>
  )
}
