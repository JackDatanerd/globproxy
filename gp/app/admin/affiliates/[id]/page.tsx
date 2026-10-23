import Link from 'next/link'
import type { ReactNode } from 'react'
import AdminReasonActionButton from '@/components/admin/AdminReasonActionButton'
import AdminAffiliateActions from '@/components/admin/AdminAffiliateActions'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { isUuid } from '@/lib/adminAuth'
import { formatCycleLabel } from '@/lib/payoutCycle'
import { AFFILIATE_HOLD_HOURS } from '@/lib/referrals'
import { formatRatePct, DEFAULT_AFFILIATE_INTRO_RATE, DEFAULT_AFFILIATE_LIFETIME_RATE } from '@/lib/rates'

const usd = (n: unknown) => `$${Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const day = (s: string | null) => s ? new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—'

function maskedDestination(p: any): string {
  if (!p.payout_method) return 'Not set'
  if (p.payout_method === 'usdt') return `USDT (TRC20) · ${String(p.payout_wallet_address ?? '').slice(0, 6)}…${String(p.payout_wallet_address ?? '').slice(-4)}`
  if (p.payout_method === 'mpesa') return `M-Pesa · ${String(p.payout_mpesa_phone ?? '').slice(0, 6)}***${String(p.payout_mpesa_phone ?? '').slice(-2)}`
  return `Bank · ${p.payout_bank_details?.bankName ?? ''} · ****${String(p.payout_bank_details?.accountNumber ?? '').slice(-4)}`
}

// One affiliate end to end — what they've earned, who they referred, what is
// scheduled / paid — so a payout, a dispute or a fraud check doesn't mean
// stitching four admin screens together by hand.
export default async function AdminAffiliateDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) notFound()
  const supabase = await createAdminClient()

  const [{ data: p }, { data: referrals }, { data: commissions }, { data: payouts }, earningsRes, { count: refCount }, { data: adjustments }] = await Promise.all([
    supabase.from('profiles').select('id, email, full_name, is_deleted, is_suspended, affiliate_status, affiliate_application, affiliate_commission_rate, affiliate_commission_rate_lifetime, is_verified_operator, payout_method, payout_wallet_address, payout_mpesa_phone, payout_bank_details, payout_method_updated_at, payout_hold_reason, referral_code, created_at').eq('id', id).maybeSingle(),
    supabase.from('referrals')
      .select('id, created_at, flagged, flag_reason, sub_id, gb_bonus_credited_at, gb_bonus_reversed_at, referred:referred_user_id(email, is_deleted)')
      .eq('referrer_id', id).order('created_at', { ascending: false }).limit(50),
    supabase.from('affiliate_commissions')
      .select('id, created_at, gross_amount_usd, commission_rate, commission_amount_usd, status, payout_id, voided_at')
      .eq('referrer_id', id).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(50),
    supabase.from('affiliate_payouts')
      .select('id, cycle_start, cycle_end, amount_usd, status, payout_method, paid_at, payment_reference')
      .eq('referrer_id', id).order('cycle_start', { ascending: false }).limit(50),
    supabase.rpc('admin_affiliate_earnings', { p_referrer_ids: [id] }),
    supabase.from('referrals').select('*', { count: 'exact', head: true }).eq('referrer_id', id),
    supabase.from('affiliate_adjustments')
      .select('id, created_at, amount_usd, reason, payout_id, waived_at')
      .eq('referrer_id', id).order('created_at', { ascending: false }).limit(50),
  ])
  if (!p) notFound()

  // Verified Operator grant / revoke history (who, when, which rates) from the
  // audit log — so a rate on this page can be traced to the decision behind it.
  const { data: voHistory } = await supabase
    .from('admin_audit_log')
    .select('id, created_at, action, details, admin:admin_id(email)')
    .eq('target_user_id', id)
    .like('action', 'verified_operator.%')
    .order('created_at', { ascending: false })
    .limit(20)

  const e = ((earningsRes.data ?? []) as any[]).find(r => r.referrer_id === id)
  // Clawbacks not yet netted into a payout (refunds / voids after payment).
  const openDeductions = -((adjustments ?? []) as any[]).filter(a => !a.payout_id && !a.waived_at).reduce((s, a) => s + Number(a.amount_usd), 0)
  const tiles: [string, string][] = [
    ['Accruing', usd(e?.accruing_usd)],
    ['Awaiting payment', usd(e?.awaiting_usd)],
    ['Paid to date', usd(e?.paid_usd)],
    ['Referrals', String(refCount ?? 0)],
    ['Open deductions', usd(openDeductions)],
  ]
  const holdUntil = p.payout_method_updated_at
    ? new Date(new Date(p.payout_method_updated_at).getTime() + AFFILIATE_HOLD_HOURS * 3_600_000)
    : null
  const inHold = !!holdUntil && holdUntil.getTime() > Date.now()
  const app = p.affiliate_application as any
  const state = (c: any) => (c.status === 'void' ? 'reversed' : c.status === 'paid' ? 'paid' : c.payout_id ? 'scheduled' : 'accruing')

  return (
    <div className="max-w-5xl">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display font-bold text-2xl text-ink">{p.is_deleted ? 'Deleted account' : (p.full_name || '—')}</h1>
          <p className="text-muted text-sm mt-1 font-mono">{p.is_deleted ? '—' : p.email}</p>
          <div className="flex flex-wrap gap-2 mt-2">
            <span className="text-[10px] font-mono bg-surface border border-border px-2 py-0.5 rounded-full">{p.affiliate_status ?? 'not an affiliate'}</span>
            {p.is_verified_operator && <span className="text-[10px] font-mono bg-accent2/10 text-accent2 px-2 py-0.5 rounded-full">✓ Verified Operator</span>}
            {p.is_suspended && <span className="text-[10px] font-mono bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full">account suspended</span>}
            {p.is_deleted && <span className="text-[10px] font-mono bg-red-50 text-red-500 px-2 py-0.5 rounded-full">deleted — do not pay</span>}
          </div>
        </div>
        <Link href="/admin/affiliates" className="text-xs font-mono text-accent hover:underline whitespace-nowrap mt-1">← Affiliates</Link>
      </div>

      {!p.is_deleted && (
        <div className="flex flex-wrap gap-2 mb-6">
          {p.affiliate_status === 'pending' && (<>
            <AdminAffiliateActions userId={p.id} action="approve" />
            <AdminAffiliateActions userId={p.id} action="reject" />
          </>)}
          {p.affiliate_status === 'approved' && (<>
            {(p.is_verified_operator || !p.is_suspended) && (
              <AdminAffiliateActions userId={p.id} action={p.is_verified_operator ? 'revokeVerifiedOperator' : 'grantVerifiedOperator'} />
            )}
            {!p.is_verified_operator && (
              <AdminAffiliateActions userId={p.id} action="editRates"
                currentIntro={Number(p.affiliate_commission_rate ?? DEFAULT_AFFILIATE_INTRO_RATE)} currentLifetime={Number(p.affiliate_commission_rate_lifetime ?? DEFAULT_AFFILIATE_LIFETIME_RATE)} />
            )}
            <AdminAffiliateActions userId={p.id} action="suspendAffiliate" />
          </>)}
          {p.affiliate_status === 'suspended' && (<>
            {p.is_verified_operator && <AdminAffiliateActions userId={p.id} action="revokeVerifiedOperator" />}
            <AdminAffiliateActions userId={p.id} action="reinstateAffiliate" />
          </>)}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        {tiles.map(([l, v]) => (
          <div key={l} className="bg-white border border-border rounded-xl p-5">
            <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-2">{l}</div>
            <div className="font-display text-2xl font-bold text-ink">{v}</div>
          </div>
        ))}
      </div>

      <div className="grid md:grid-cols-2 gap-4 mb-6">
        <div className="bg-white border border-border rounded-xl p-5 text-xs flex flex-col gap-1.5">
          <div className="text-sm font-medium text-ink mb-1">Terms</div>
          <div><span className="text-muted">Rates (intro / lifetime): </span><span className="font-mono">{formatRatePct(p.affiliate_commission_rate ?? 0.3)} / {formatRatePct(p.affiliate_commission_rate_lifetime ?? 0.15)}</span></div>
          <div><span className="text-muted">Referral code: </span><span className="font-mono">{p.referral_code ?? '—'}</span></div>
          <div><span className="text-muted">Joined: </span><span className="font-mono">{day(p.created_at)}</span></div>
          {app?.channel && <div><span className="text-muted">Channel: </span>{app.channel}</div>}
          {app?.audience && <div><span className="text-muted">Audience: </span>{app.audience}</div>}
        </div>
        <div className="bg-white border border-border rounded-xl p-5 text-xs flex flex-col gap-1.5">
          <div className="text-sm font-medium text-ink mb-1">Payout destination</div>
          <div className="font-mono">{p.is_deleted ? 'Removed with the account' : maskedDestination(p)}</div>
          {p.payout_method_updated_at && !p.is_deleted && (
            <div className={inHold ? 'text-amber-700' : 'text-muted'}>
              {p.payout_hold_reason === 'security_event' ? 'Account security change' : 'Changed'} {day(p.payout_method_updated_at)}{inHold ? ` — security hold until ${holdUntil!.toISOString().slice(0, 16).replace('T', ' ')} UTC` : ' — hold cleared'}
            </div>
          )}
          <div className="text-[10px] text-muted mt-1">Full details appear on the payout row when you are about to send it.</div>
        </div>
      </div>

      {(voHistory?.length ?? 0) > 0 && (
        <Section title="Verified Operator history" empty="" rows={voHistory ?? []} heads={['When', 'Action', 'By', 'Rates (intro / lifetime)', 'Reason']}
          cell={(r: any) => {
            const d = r.details ?? {}
            const grant = r.action === 'verified_operator.grant'
            const a = grant ? d.intro_rate : d.restored_intro_rate
            const b = grant ? d.lifetime_rate : d.restored_lifetime_rate
            return [day(r.created_at), grant ? 'Granted' : 'Revoked', (r.admin as any)?.email ?? 'system',
              a != null && b != null ? `${formatRatePct(a)} / ${formatRatePct(b)}` : '—',
              d.reason ?? '—']
          }} />
      )}

      <Section title="Payouts" empty="No payouts yet." rows={payouts ?? []} heads={['Cycle', 'Amount', 'Method', 'Status', 'Paid', 'Reference']}
        cell={(r: any) => [formatCycleLabel(r), usd(r.amount_usd), r.payout_method, r.status, day(r.paid_at), r.payment_reference ?? '—']} />

      <Section title="Commissions (latest 50)" empty="No commissions yet." rows={commissions ?? []} heads={['Date', 'Order', 'Rate', 'Commission', 'State', '']}
        cell={(r: any) => [day(r.created_at), usd(r.gross_amount_usd), formatRatePct(r.commission_rate), usd(r.commission_amount_usd), r.voided_at && r.status === 'paid' ? 'paid — recovering' : state(r),
          r.status !== 'void' && !r.voided_at ? (
            <AdminReasonActionButton key={r.id} label={r.status === 'paid' ? 'Recover' : 'Void'} endpoint="/api/admin/void-commission" payload={{ commissionId: r.id }}
              confirmText={r.status === 'paid'
                ? 'This commission was already paid out. Record a deduction to net against the affiliate\'s future payouts?'
                : 'Void this commission? It is removed from the affiliate\'s balance (and from any pending payout).'}
              successText={r.status === 'paid' ? 'Deduction recorded' : 'Commission voided'} />
          ) : '']} />

      <Section title="Deductions (refunds & recoveries)" empty="No deductions." rows={adjustments ?? []} heads={['Date', 'Amount', 'Reason', 'State', '']}
        cell={(r: any) => [day(r.created_at), usd(r.amount_usd), r.reason === 'refund_after_paid' ? 'Refund after payout' : 'Admin recovery',
          r.waived_at ? 'waived' : r.payout_id ? 'netted into a payout' : 'open — nets on the next payout',
          !r.payout_id && !r.waived_at ? (
            <AdminReasonActionButton key={r.id} label="Waive" tone="neutral" endpoint="/api/admin/waive-adjustment" payload={{ adjustmentId: r.id }}
              confirmText="Waive this deduction? It will not be taken from the affiliate's payouts. The affiliate is emailed." successText="Deduction waived" />
          ) : '']} />

      <Section title="Referrals (latest 50)" empty="No referrals yet." rows={referrals ?? []} heads={['Signed up', 'User', 'Sub ID', 'Flag', 'GB bonus', '']}
        cell={(r: any) => [
          day(r.created_at),
          r.referred?.is_deleted ? 'deleted account' : (r.referred?.email ?? '—'),
          r.sub_id ?? '—',
          r.flagged ? `flagged — ${r.flag_reason ?? ''}` : '—',
          r.gb_bonus_reversed_at ? 'reversed (refund)' : r.gb_bonus_credited_at ? 'credited' : '—',
          <AdminReasonActionButton key={r.id} label="Void earnings" endpoint="/api/admin/void-referral-earnings" payload={{ referralId: r.id }}
            confirmText="Flag this referral as fraud and void EVERYTHING it earned? Unpaid commissions are removed; commissions already paid out become deductions against the affiliate's future payouts."
            successText="Earnings voided" />,
        ]} />
    </div>
  )
}

function Section({ title, empty, rows, heads, cell }: { title: string; empty: string; rows: any[]; heads: string[]; cell: (r: any) => ReactNode[] }) {
  return (
    <div className="bg-white border border-border rounded-xl overflow-hidden mb-6">
      <div className="px-6 py-4 border-b border-border"><h2 className="font-display font-bold text-base text-ink">{title}</h2></div>
      {rows.length === 0 ? (
        <div className="text-center py-8 text-muted text-sm font-light">{empty}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-surface">
                {heads.map(h => <th key={h} className="text-left px-6 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id ?? i} className={i < rows.length - 1 ? 'border-b border-border' : ''}>
                  {cell(r).map((c, j) => <td key={j} className="px-6 py-3 text-xs font-mono text-ink">{c}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
