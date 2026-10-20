import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { isUuid } from '@/lib/adminAuth'
import { formatCycleLabel } from '@/lib/payoutCycle'
import { AFFILIATE_HOLD_HOURS, formatRatePct } from '@/lib/referrals'

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

  const [{ data: p }, { data: referrals }, { data: commissions }, { data: payouts }, earningsRes, { count: refCount }] = await Promise.all([
    supabase.from('profiles').select('id, email, full_name, is_deleted, is_suspended, affiliate_status, affiliate_application, affiliate_commission_rate, affiliate_commission_rate_lifetime, is_verified_operator, payout_method, payout_wallet_address, payout_mpesa_phone, payout_bank_details, payout_method_updated_at, referral_code, created_at').eq('id', id).maybeSingle(),
    supabase.from('referrals')
      .select('id, created_at, flagged, flag_reason, sub_id, gb_bonus_credited_at, gb_bonus_reversed_at, referred:referred_user_id(email, is_deleted)')
      .eq('referrer_id', id).order('created_at', { ascending: false }).limit(50),
    supabase.from('affiliate_commissions')
      .select('id, created_at, gross_amount_usd, commission_rate, commission_amount_usd, status, payout_id')
      .eq('referrer_id', id).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(50),
    supabase.from('affiliate_payouts')
      .select('id, cycle_start, cycle_end, amount_usd, status, payout_method, paid_at, payment_reference')
      .eq('referrer_id', id).order('cycle_start', { ascending: false }).limit(50),
    supabase.rpc('admin_affiliate_earnings'),
    supabase.from('referrals').select('*', { count: 'exact', head: true }).eq('referrer_id', id),
  ])
  if (!p) notFound()

  const e = ((earningsRes.data ?? []) as any[]).find(r => r.referrer_id === id)
  const tiles: [string, string][] = [
    ['Accruing', usd(e?.accruing_usd)],
    ['Awaiting payment', usd(e?.awaiting_usd)],
    ['Paid to date', usd(e?.paid_usd)],
    ['Referrals', String(refCount ?? 0)],
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

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
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
              Changed {day(p.payout_method_updated_at)}{inHold ? ` — security hold until ${holdUntil!.toISOString().slice(0, 16).replace('T', ' ')} UTC` : ' — hold cleared'}
            </div>
          )}
          <div className="text-[10px] text-muted mt-1">Full details appear on the payout row when you are about to send it.</div>
        </div>
      </div>

      <Section title="Payouts" empty="No payouts yet." rows={payouts ?? []} heads={['Cycle', 'Amount', 'Method', 'Status', 'Paid', 'Reference']}
        cell={(r: any) => [formatCycleLabel(r), usd(r.amount_usd), r.payout_method, r.status, day(r.paid_at), r.payment_reference ?? '—']} />

      <Section title="Commissions (latest 50)" empty="No commissions yet." rows={commissions ?? []} heads={['Date', 'Order', 'Rate', 'Commission', 'State']}
        cell={(r: any) => [day(r.created_at), usd(r.gross_amount_usd), formatRatePct(r.commission_rate), usd(r.commission_amount_usd), state(r)]} />

      <Section title="Referrals (latest 50)" empty="No referrals yet." rows={referrals ?? []} heads={['Signed up', 'User', 'Sub ID', 'Flag', 'GB bonus']}
        cell={(r: any) => [
          day(r.created_at),
          r.referred?.is_deleted ? 'deleted account' : (r.referred?.email ?? '—'),
          r.sub_id ?? '—',
          r.flagged ? `flagged — ${r.flag_reason ?? ''}` : '—',
          r.gb_bonus_reversed_at ? 'reversed (refund)' : r.gb_bonus_credited_at ? 'credited' : '—',
        ]} />
    </div>
  )
}

function Section({ title, empty, rows, heads, cell }: { title: string; empty: string; rows: any[]; heads: string[]; cell: (r: any) => string[] }) {
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
                <tr key={r.id} className={i < rows.length - 1 ? 'border-b border-border' : ''}>
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
