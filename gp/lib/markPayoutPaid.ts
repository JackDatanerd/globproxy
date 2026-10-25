import type { AdminSupabase } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { adminNoticeHtml, appUrl } from '@/lib/adminEmail'
import { sendEmailSafe, escapeHtml } from '@/lib/email'
import { formatCycleLabel } from '@/lib/payoutCycle'
import { getKesQuote } from '@/lib/fx'

export type MarkPaidResult = { ok: true } | { ok: false; status: number; error: string; code?: 'affiliate_suspended' }

// Records that one affiliate payout was sent. The actual money movement (USDT
// transfer, bank wire, M-Pesa) happens outside the app; this records that it
// happened, WHO recorded it and the payment reference, and notifies the
// affiliate. Shared by the single and bulk routes so both behave identically.
export async function markPayoutPaid(
  supabase: AdminSupabase,
  adminId: string,
  payoutId: string,
  reference: string,
  opts: { allowSuspended?: boolean; kesAmount?: number | null } = {}
): Promise<MarkPaidResult> {
  // A payout for a deleted account can never be paid (its destination was
  // erased on deletion). Deletion now removes pending payouts itself; this
  // also refuses any that predate that.
  const { data: pre } = await supabase
    .from('affiliate_payouts')
    .select('status, referrer:referrer_id(is_deleted, is_suspended, affiliate_status)')
    .eq('id', payoutId)
    .maybeSingle()
  if (!pre) return { ok: false, status: 404, error: 'Payout not found' }
  if ((pre.referrer as any)?.is_deleted) {
    return { ok: false, status: 409, error: 'This affiliate\'s account was deleted — their payout destination is gone. Void this payout instead.' }
  }

  // A suspended affiliate (account suspended, or affiliate status suspended) is
  // usually suspended for a reason that bears on the money — fraud, a chargeback.
  // The pending-payouts table only hides the checkbox; the single "Mark paid"
  // button and any direct call went straight through. Refused here unless the
  // admin explicitly overrides (the single route's overrideSuspended, which the
  // button asks for after a confirm); bulk never overrides.
  const ref = pre.referrer as any
  if ((ref?.is_suspended || ref?.affiliate_status === 'suspended') && !opts.allowSuspended) {
    return { ok: false, status: 409, code: 'affiliate_suspended', error: 'This affiliate is suspended — check why before paying. Confirm to pay anyway, or void the payout.' }
  }

  // mark_affiliate_payout_paid is the idempotent, atomic claim (updates the
  // payout row AND mirrors status onto its still-pending linked commissions
  // in one transaction) — migration 0043. false = already paid, surfaced as
  // 409 so a double-click doesn't look like it did something twice.
  const { data: claimed, error: rpcErr } = await supabase.rpc('mark_affiliate_payout_paid', {
    p_payout_id: payoutId,
    p_paid_by: adminId,
    p_reference: reference || null,
  })
  if (rpcErr) return { ok: false, status: 500, error: rpcErr.message }
  if (!claimed) return { ok: false, status: 409, error: 'This payout is not in a payable state (already paid?)' }

  const { data: payout } = await supabase
    .from('affiliate_payouts')
    .select('referrer_id, amount_usd, cycle_start, cycle_end, payout_method, referrer:referrer_id(email, full_name)')
    .eq('id', payoutId)
    .single()

  // M-Pesa pays out in shillings. Record what was actually sent (the admin's figure for a
  // single payout) or, failing that, the market rate at this moment — never the checkout
  // rate with its markup, which would shortchange the affiliate. Without this the
  // affiliate saw only a USD figure and nobody could reconcile the KES that left.
  let kes: { amount: number; rate: number } | null = null
  if (payout && payout.payout_method === 'mpesa') {
    const usd = Number(payout.amount_usd)
    if (opts.kesAmount && Number.isFinite(opts.kesAmount) && opts.kesAmount > 0 && usd > 0) {
      kes = { amount: Math.round(opts.kesAmount), rate: Math.round((opts.kesAmount / usd) * 10000) / 10000 }
    } else {
      try {
        const q = await getKesQuote(supabase as any)
        if (q && usd > 0) kes = { amount: Math.round(usd * q.market), rate: q.market }
      } catch (e) { console.error('[markPayoutPaid] could not fetch a KES rate', e) }
    }
    if (kes) {
      const { error: kesErr } = await supabase.from('affiliate_payouts')
        .update({ payout_local_currency: 'KES', payout_local_amount: kes.amount, payout_fx_rate: kes.rate }).eq('id', payoutId)
      if (kesErr) { console.error('[markPayoutPaid] could not record the KES amount', payoutId, kesErr.message); kes = null }
    }
  }

  await logAdminAction(supabase, {
    adminId, action: 'payout.mark_paid', targetUserId: payout?.referrer_id ?? null, targetRef: payoutId,
    details: { amount_usd: payout ? Number(payout.amount_usd) : undefined, method: payout?.payout_method, reference: reference || undefined, ...(kes ? { kes_amount: kes.amount, kes_rate: kes.rate } : {}), ...(opts.allowSuspended && (ref?.is_suspended || ref?.affiliate_status === 'suspended') ? { paid_while_suspended: true } : {}) },
  })

  const referrer = payout?.referrer as any
  if (referrer?.email && referrer.email !== '[deleted]' && payout) {
    const methodLabel = payout.payout_method === 'usdt' ? 'USDT (TRC20)' : payout.payout_method === 'mpesa' ? 'M-Pesa' : 'bank transfer'
    const delivered = await sendEmailSafe({
      to: referrer.email,
      subject: 'Your GlobProxy affiliate payout has been sent',
      html: adminNoticeHtml({
        heading: 'Payout sent ✓',
        bodyHtml: `Hi ${escapeHtml(referrer.full_name?.split(' ')[0]) || 'there'}, your affiliate payout of <strong>$${Number(payout.amount_usd).toFixed(2)}</strong> for ${escapeHtml(formatCycleLabel(payout))} has been sent via ${methodLabel}${kes ? ` as <strong>KES ${kes.amount.toLocaleString('en-US')}</strong> (at ${kes.rate.toFixed(2)} KES per USD)` : ''}.${reference ? `<br/><span style="font-size:12px;color:#888;">Reference: ${escapeHtml(reference)}</span>` : ''}`,
        cta: { href: `${appUrl()}/dashboard/referrals`, label: 'View your payout history →' },
      }),
    })
    // notified_at used to be stamped before (and regardless of) the send.
    if (delivered) {
      await supabase.from('affiliate_payouts').update({ notified_at: new Date().toISOString() }).eq('id', payoutId)
    }
  }

  return { ok: true }
}
