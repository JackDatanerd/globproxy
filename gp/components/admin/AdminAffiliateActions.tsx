'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'
import { formatRatePct, ratePctValue, VERIFIED_OPERATOR_INTRO_RATE, VERIFIED_OPERATOR_LIFETIME_RATE, DEFAULT_AFFILIATE_INTRO_RATE, DEFAULT_AFFILIATE_LIFETIME_RATE, MAX_AFFILIATE_INTRO_RATE, MAX_AFFILIATE_LIFETIME_RATE } from '@/lib/rates'

// One component, one discriminated prop shape, for every affiliate-side
// admin button. 'markPaid' takes a payoutId — a whole cycle's payout to one
// affiliate, not a single commission (affiliate_payouts is the batch).
type Props =
  | { userId: string; action: 'approve' | 'reject' | 'suspendAffiliate' | 'reinstateAffiliate' | 'grantVerifiedOperator' | 'revokeVerifiedOperator'; payoutId?: never }
  | { userId: string; action: 'editRates'; currentIntro: number; currentLifetime: number; payoutId?: never }
  | { payoutId: string; action: 'markPaid' | 'voidPayout' | 'reversePayout'; amountUsd?: number; mpesaKesDefault?: number | null; isMpesa?: boolean; userId?: never }

// Prompts take whole percentages ("30"), the API takes fractions (0.30).
// `def` is pre-filled EXACTLY (ratePctValue) — it used to be Math.round()ed, so
// accepting the default on a 12.5% rate silently rewrote it to 13%.
// `max` is the ceiling as a fraction (the API enforces the same one).
function askPercent(label: string, def: string, max: number): number | null {
  const maxPct = Math.round(max * 10000) / 100
  const raw = window.prompt(`${label} (max ${maxPct}%)`, def)
  if (raw === null) return null
  const n = Number(raw.replace('%', '').trim())
  if (raw.trim() === '' || !Number.isFinite(n) || n < 0 || n > maxPct) { toast.error(`Enter a percentage between 0 and ${maxPct}`); return null }
  return n / 100
}

// Required free-text reason for a decision that changes what an affiliate earns.
function askReason(label: string): string | null {
  const reason = window.prompt(label, '')
  if (reason === null) return null
  if (reason.trim().length < 3) { toast.error('A reason (at least 3 characters) is required'); return null }
  return reason.trim()
}

export default function AdminAffiliateActions(props: Props) {
  const [loading, setLoading] = useState(false)

  async function handle() {
    let path = ''
    let body: Record<string, unknown> = {}
    let success = ''

    switch (props.action) {
      case 'approve': {
        const intro = askPercent(`Commission % for the first 90 days of each referral (default ${formatRatePct(DEFAULT_AFFILIATE_INTRO_RATE)}):`, ratePctValue(DEFAULT_AFFILIATE_INTRO_RATE), MAX_AFFILIATE_INTRO_RATE)
        if (intro === null) return
        const lifetime = askPercent(`Commission % after the first 90 days (default ${formatRatePct(DEFAULT_AFFILIATE_LIFETIME_RATE)}):`, ratePctValue(DEFAULT_AFFILIATE_LIFETIME_RATE), MAX_AFFILIATE_LIFETIME_RATE)
        if (lifetime === null) return
        path = '/api/admin/approve-affiliate'; body = { userId: props.userId, introRate: intro, lifetimeRate: lifetime }; success = 'Affiliate approved'
        break
      }
      case 'reject': {
        // Cancel aborts; a blank note just means no note. The note goes in the
        // applicant's email and the audit log.
        const reason = window.prompt('Optional note to include in the rejection email (leave blank for none):', '')
        if (reason === null) return
        path = '/api/admin/reject-affiliate'; body = { userId: props.userId, reason }; success = 'Application rejected'
        break
      }
      case 'markPaid': {
        const amount = props.amountUsd != null ? ` of $${props.amountUsd.toFixed(2)}` : ''
        const ref = window.prompt(`Mark this payout${amount} as PAID.\n\nOnly continue once the money has actually been sent. Payment reference (txn hash / M-Pesa code — optional, shown to the affiliate):`, '')
        if (ref === null) return
        let kesAmount: number | undefined
        if (props.isMpesa) {
          const k = window.prompt(`Shillings (KES) actually sent by M-Pesa — recorded and shown to the affiliate. Prefilled with the market-rate figure; change it if you sent a different amount:`, props.mpesaKesDefault ? String(props.mpesaKesDefault) : '')
          if (k === null) return
          if (k.trim()) {
            const n = Number(k.replace(/,/g, '').trim())
            if (!Number.isFinite(n) || n <= 0) { toast.error('Enter the KES amount as a number'); return }
            kesAmount = n
          }
        }
        path = '/api/admin/mark-payout-paid'; body = { payoutId: props.payoutId, reference: ref, ...(props.amountUsd != null ? { expectedAmountUsd: props.amountUsd } : {}), ...(kesAmount ? { kesAmount } : {}) }; success = 'Marked as paid'
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
      case 'reversePayout': {
        const amount = props.amountUsd != null ? ` of $${props.amountUsd.toFixed(2)}` : ''
        if (!confirm(`Reverse this PAID payout${amount}?\n\nUse this only when the money did NOT arrive (wrong address, failed transfer, returned wire). It goes back to Pending so you can re-send it or void it, and the affiliate is told it was not completed. If it DID arrive, do not reverse it.`)) return
        const reason = window.prompt('Reason (required — recorded in the audit log, shown to the affiliate):', '')
        if (!reason?.trim() || reason.trim().length < 3) { if (reason !== null) toast.error('A reason (at least 3 characters) is required'); return }
        path = '/api/admin/reverse-payout'; body = { payoutId: props.payoutId, reason: reason.trim() }; success = 'Payout moved back to pending'
        break
      }
      case 'grantVerifiedOperator': {
        if (!confirm(`Make this affiliate a Verified Operator? Their rates rise to ${formatRatePct(VERIFIED_OPERATOR_INTRO_RATE)} / ${formatRatePct(VERIFIED_OPERATOR_LIFETIME_RATE)} (a higher existing rate is kept).`)) return
        const reason = askReason('Why is this affiliate being made a Verified Operator? (required — recorded in the audit log)')
        if (reason === null) return
        path = '/api/admin/grant-verified-operator'; body = { userId: props.userId, reason }; success = 'Granted Verified Operator'
        break
      }
      case 'revokeVerifiedOperator': {
        if (!confirm('Revoke Verified Operator? Their rates go back to what they had before the upgrade.')) return
        const reason = askReason('Why is Verified Operator being revoked? (required — recorded in the audit log)')
        if (reason === null) return
        path = '/api/admin/grant-verified-operator'; body = { userId: props.userId, revoke: true, reason }; success = 'Verified Operator revoked'
        break
      }
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
        const intro = askPercent('New commission % for the first 90 days:', ratePctValue(props.currentIntro), MAX_AFFILIATE_INTRO_RATE)
        if (intro === null) return
        const lifetime = askPercent('New commission % after the first 90 days:', ratePctValue(props.currentLifetime), MAX_AFFILIATE_LIFETIME_RATE)
        if (lifetime === null) return
        path = '/api/admin/set-affiliate-rates'; body = { userId: props.userId, introRate: intro, lifetimeRate: lifetime }; success = 'Rates updated'
        break
      }
    }

    setLoading(true)
    let { ok, data } = await adminPost(path, body)
    // A suspended affiliate's payout is refused by the server unless confirmed.
    if (!ok && (data as any).code === 'affiliate_suspended') {
      if (confirm(`${data.error}\n\nPay it anyway?`)) ({ ok, data } = await adminPost(path, { ...body, overrideSuspended: true }))
    }
    // A Verified Operator granted before pre-upgrade rates were recorded: ask what to restore.
    if (!ok && (data as any).code === 'restore_rates_required') {
      const d = (data as any).defaults ?? {}
      const intro = askPercent('Restore the commission % for the first 90 days to:', ratePctValue(d.intro ?? DEFAULT_AFFILIATE_INTRO_RATE), MAX_AFFILIATE_INTRO_RATE)
      const lifetime = intro === null ? null : askPercent('Restore the commission % after the first 90 days to:', ratePctValue(d.lifetime ?? DEFAULT_AFFILIATE_LIFETIME_RATE), MAX_AFFILIATE_LIFETIME_RATE)
      if (intro !== null && lifetime !== null) ({ ok, data } = await adminPost(path, { ...body, restoreIntroRate: intro, restoreLifetimeRate: lifetime }))
    }
    if (!ok) { toast.error(data.error ?? 'Action failed'); setLoading(false); return }
    toast.success(success)
    window.location.reload()
  }

  const danger = props.action === 'reject' || props.action === 'voidPayout' || props.action === 'reversePayout' || props.action === 'revokeVerifiedOperator' || props.action === 'suspendAffiliate'
  const neutral = props.action === 'editRates'
  const label = loading ? '...'
    : props.action === 'approve' ? 'Approve'
    : props.action === 'reject' ? 'Reject'
    : props.action === 'markPaid' ? 'Mark paid'
    : props.action === 'voidPayout' ? 'Void'
    : props.action === 'reversePayout' ? 'Reverse'
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
