import { createAdminClient } from '@/lib/supabase/server'
import AdminAffiliateActions from '@/components/admin/AdminAffiliateActions'
import RunPayoutCycleButton from '@/components/admin/RunPayoutCycleButton'
import { formatCycleLabel } from '@/lib/payoutCycle'

export default async function AdminAffiliatesPage() {
  const supabase = await createAdminClient()
  const [{ data: applicants }, { data: affiliates }, { data: pendingPayouts }] = await Promise.all([
    supabase.from('profiles').select('*').eq('affiliate_status', 'pending').order('created_at', { ascending: false }),
    supabase.from('profiles').select('*').eq('affiliate_status', 'approved').order('created_at', { ascending: false }),
    supabase.from('affiliate_payouts').select('*, referrer:referrer_id(email, full_name)').eq('status', 'pending').order('cycle_start', { ascending: false }),
  ])

  const affiliateIds = affiliates?.map(a => a.id) ?? []
  const { data: allCommissions } = affiliateIds.length > 0
    ? await supabase.from('affiliate_commissions').select('referrer_id, commission_amount_usd, status').in('referrer_id', affiliateIds)
    : { data: [] }

  const earningsByAffiliate: Record<string, { pending: number; paid: number }> = {}
  for (const c of allCommissions ?? []) {
    const bucket = earningsByAffiliate[c.referrer_id] ?? { pending: 0, paid: 0 }
    if (c.status === 'paid') bucket.paid += Number(c.commission_amount_usd)
    else if (c.status === 'pending') bucket.pending += Number(c.commission_amount_usd)
    earningsByAffiliate[c.referrer_id] = bucket
  }

  return (
    <div className="max-w-5xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">Affiliates</h1>
        <p className="text-muted text-sm mt-1">Manage affiliate applications and biweekly payouts</p>
      </div>

      {/* Pending applications */}
      {applicants && applicants.length > 0 && (
        <div className="mb-8">
          <h2 className="font-display font-bold text-base text-ink mb-3">
            Pending applications
            <span className="ml-2 text-xs font-mono bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full">
              {applicants.length}
            </span>
          </h2>
          <div className="flex flex-col gap-3">
            {applicants.map(a => {
              const app = a.affiliate_application as any
              return (
                <div key={a.id} className="bg-white border border-border rounded-xl p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-3">
                        <div className="text-sm font-medium text-ink">{a.full_name || '—'}</div>
                        <span className="text-[10px] font-mono bg-yellow-50 text-yellow-600 px-2 py-0.5 rounded-full">pending</span>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <div className="flex gap-2">
                          <span className="text-[10px] font-mono text-muted uppercase tracking-wider w-20 flex-shrink-0">Email</span>
                          <span className="text-xs text-ink">{a.email}</span>
                        </div>
                        <div className="flex gap-2">
                          <span className="text-[10px] font-mono text-muted uppercase tracking-wider w-20 flex-shrink-0">Channel</span>
                          <span className="text-xs text-ink">{app?.channel || '—'}</span>
                        </div>
                        <div className="flex gap-2">
                          <span className="text-[10px] font-mono text-muted uppercase tracking-wider w-20 flex-shrink-0">Audience</span>
                          <span className="text-xs text-ink">{app?.audience || '—'}</span>
                        </div>
                        <div className="flex gap-2">
                          <span className="text-[10px] font-mono text-muted uppercase tracking-wider w-20 flex-shrink-0">Plan</span>
                          <span className="text-xs text-ink">{app?.plan || '—'}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-2 flex-shrink-0">
                      <AdminAffiliateActions userId={a.id} action="approve" />
                      <AdminAffiliateActions userId={a.id} action="reject" />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Pending payouts */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-display font-bold text-base text-ink">
            Pending payouts
            {pendingPayouts && pendingPayouts.length > 0 && (
              <span className="ml-2 text-xs font-mono bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full">
                {pendingPayouts.length}
              </span>
            )}
          </h2>
          <RunPayoutCycleButton />
        </div>
        {pendingPayouts && pendingPayouts.length > 0 ? (
          <div className="bg-white border border-border rounded-xl overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-surface">
                  {['Affiliate', 'Cycle', 'Amount', 'Send to', 'Actions'].map(h => (
                    <th key={h} className="text-left px-6 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pendingPayouts.map((p: any, i: number) => (
                  <tr key={p.id} className={i < pendingPayouts.length - 1 ? 'border-b border-border' : ''}>
                    <td className="px-6 py-4">
                      <div className="text-sm font-medium text-ink">{p.referrer?.full_name || '—'}</div>
                      <div className="text-xs font-mono text-muted">{p.referrer?.email}</div>
                    </td>
                    <td className="px-6 py-4 text-xs font-mono text-muted">{formatCycleLabel(p)}</td>
                    <td className="px-6 py-4 font-mono text-sm text-accent">${Number(p.amount_usd).toFixed(2)}</td>
                    <td className="px-6 py-4 text-xs font-mono text-ink">
                      {p.payout_method === 'usdt' ? (
                        <>USDT (TRC20)<br /><span className="text-muted">{p.payout_wallet_address}</span></>
                      ) : (
                        <>{p.payout_bank_details?.bankName}<br /><span className="text-muted">{p.payout_bank_details?.accountName} · {p.payout_bank_details?.accountNumber}</span></>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <AdminAffiliateActions payoutId={p.id} action="markPaid" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="bg-white border border-border rounded-xl p-10 text-center text-muted text-sm font-light">
            No pending payouts — run a cycle above to batch this period's commissions.
          </div>
        )}
      </div>

      {/* Active affiliates */}
      <div className="bg-white border border-border rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <h2 className="font-display font-bold text-base text-ink">Active affiliates ({affiliates?.length ?? 0})</h2>
        </div>
        {affiliates && affiliates.length > 0 ? (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-surface">
                {['Affiliate', 'Rate (intro / lifetime)', 'Accruing', 'Paid to date', 'Joined'].map(h => (
                  <th key={h} className="text-left px-6 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {affiliates.map((a, i) => {
                const earnings = earningsByAffiliate[a.id] ?? { pending: 0, paid: 0 }
                return (
                  <tr key={a.id} className={i < (affiliates?.length ?? 0) - 1 ? 'border-b border-border' : ''}>
                    <td className="px-6 py-4">
                      <div className="text-sm font-medium text-ink">{a.full_name || '—'}</div>
                      <div className="text-xs font-mono text-muted">{a.email}</div>
                    </td>
                    <td className="px-6 py-4 font-mono text-sm text-ink">
                      {Math.round(Number(a.affiliate_commission_rate ?? 0.3) * 100)}% / {Math.round(Number(a.affiliate_commission_rate_lifetime ?? 0.15) * 100)}%
                    </td>
                    <td className="px-6 py-4 font-mono text-sm text-ink">${earnings.pending.toFixed(2)}</td>
                    <td className="px-6 py-4 font-mono text-sm text-accent">${earnings.paid.toFixed(2)}</td>
                    <td className="px-6 py-4 text-xs font-mono text-muted">
                      {new Date(a.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <div className="text-center py-14 text-muted text-sm font-light">No approved affiliates yet.</div>
        )}
      </div>
    </div>
  )
}
