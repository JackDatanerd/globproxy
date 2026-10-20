import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/server'
import AdminAffiliateActions from '@/components/admin/AdminAffiliateActions'
import RunPayoutCycleButton from '@/components/admin/RunPayoutCycleButton'
import ExportPayoutsButton from '@/components/admin/ExportPayoutsButton'
import { formatCycleLabel } from '@/lib/payoutCycle'

export default async function AdminAffiliatesPage() {
  const supabase = await createAdminClient()
  // Deleted accounts keep their affiliate_status on the '[deleted]' tombstone,
  // so every list excludes is_deleted. 'suspended' affiliates get their own
  // section (status can now be set by /api/admin/suspend-affiliate).
  const [{ data: applicants }, { data: affiliates }, { data: suspendedAffiliates }, { data: pendingPayouts }, { data: paidPayouts }, earningsRes] = await Promise.all([
    supabase.from('profiles').select('*').eq('affiliate_status', 'pending').eq('is_deleted', false).order('created_at', { ascending: false }),
    supabase.from('profiles').select('*').eq('affiliate_status', 'approved').eq('is_deleted', false).order('created_at', { ascending: false }),
    supabase.from('profiles').select('*').eq('affiliate_status', 'suspended').eq('is_deleted', false).order('created_at', { ascending: false }),
    supabase.from('affiliate_payouts').select('*, referrer:referrer_id(email, full_name, is_deleted, is_suspended, affiliate_status)').eq('status', 'pending').order('cycle_start', { ascending: false }),
    supabase.from('affiliate_payouts').select('id, amount_usd, cycle_start, cycle_end, payout_method, paid_at, payment_reference, referrer:referrer_id(email, full_name), payer:paid_by(email)').eq('status', 'paid').order('paid_at', { ascending: false }).limit(15),
    // Per-affiliate totals computed in SQL (migration 0043) — not by pulling
    // every commission row through a giant `.in()` filter.
    supabase.rpc('admin_affiliate_earnings'),
  ])

  const earningsByAffiliate: Record<string, { accruing: number; awaiting: number; paid: number }> = {}
  for (const e of (earningsRes.data ?? []) as { referrer_id: string; accruing_usd: number; awaiting_usd: number; paid_usd: number }[]) {
    earningsByAffiliate[e.referrer_id] = { accruing: Number(e.accruing_usd), awaiting: Number(e.awaiting_usd), paid: Number(e.paid_usd) }
  }
  const rate = (v: unknown, def: number) => Math.round(Number(v ?? def) * 100)

  return (
    <div className="max-w-5xl">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display font-bold text-2xl text-ink">Affiliates</h1>
          <p className="text-muted text-sm mt-1">Manage affiliate applications and biweekly payouts</p>
        </div>
        <div className="flex flex-col items-end gap-1 mt-1">
          <Link href="/admin/cycles" className="text-xs font-mono text-accent hover:underline whitespace-nowrap">
            Sales &amp; profit per cycle →
          </Link>
          <Link href="/admin/referrals" className="text-xs font-mono text-accent hover:underline whitespace-nowrap">
            Flagged referrals →
          </Link>
        </div>
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
          <div className="flex items-center gap-2">
            <ExportPayoutsButton status="pending" />
            <RunPayoutCycleButton />
          </div>
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
                      <div className="text-sm font-medium text-ink">
                        {p.referrer?.full_name || '—'}
                        {p.referrer?.is_deleted && <span className="ml-2 text-[10px] font-mono bg-red-50 text-red-500 px-2 py-0.5 rounded-full">Deleted — do not pay</span>}
                        {!p.referrer?.is_deleted && (p.referrer?.is_suspended || p.referrer?.affiliate_status === 'suspended') && <span className="ml-2 text-[10px] font-mono bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full">Suspended — check before paying</span>}
                      </div>
                      <div className="text-xs font-mono text-muted">{p.referrer?.email}</div>
                      <Link href={`/admin/affiliates/${p.referrer_id}`} className="text-[10px] font-mono text-accent hover:underline">Details →</Link>
                    </td>
                    <td className="px-6 py-4 text-xs font-mono text-muted">{formatCycleLabel(p)}</td>
                    <td className="px-6 py-4 font-mono text-sm text-accent">${Number(p.amount_usd).toFixed(2)}</td>
                    <td className="px-6 py-4 text-xs font-mono text-ink">
                      {p.referrer?.is_deleted ? (
                        <span className="text-muted">Account deleted — destination removed</span>
                      ) : p.payout_method === 'usdt' ? (
                        <>USDT (TRC20)<br /><span className="text-muted">{p.payout_wallet_address}</span></>
                      ) : p.payout_method === 'mpesa' ? (
                        <>M-Pesa<br /><span className="text-muted">{p.payout_mpesa_phone}</span></>
                      ) : (
                        <>{p.payout_bank_details?.bankName}<br /><span className="text-muted">{p.payout_bank_details?.accountName} · {p.payout_bank_details?.accountNumber}</span></>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex gap-2">
                        <AdminAffiliateActions payoutId={p.id} action="markPaid" amountUsd={Number(p.amount_usd)} />
                        <AdminAffiliateActions payoutId={p.id} action="voidPayout" amountUsd={Number(p.amount_usd)} />
                      </div>
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
                {['Affiliate', 'Rate (intro / lifetime)', 'Accruing', 'Awaiting payment', 'Paid to date', 'Joined', 'Actions'].map(h => (
                  <th key={h} className="text-left px-6 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {affiliates.map((a, i) => {
                const earnings = earningsByAffiliate[a.id] ?? { accruing: 0, awaiting: 0, paid: 0 }
                return (
                  <tr key={a.id} className={i < (affiliates?.length ?? 0) - 1 ? 'border-b border-border' : ''}>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <Link href={`/admin/affiliates/${a.id}`} className="text-sm font-medium text-ink hover:text-accent hover:underline">{a.full_name || '—'}</Link>
                        {a.is_verified_operator && (
                          <span className="text-[10px] font-mono bg-accent2/10 text-accent2 px-2 py-0.5 rounded-full">✓ Verified Operator</span>
                        )}
                      </div>
                      <div className="text-xs font-mono text-muted">{a.email}</div>
                    </td>
                    <td className="px-6 py-4 font-mono text-sm text-ink">
                      {rate(a.affiliate_commission_rate, 0.3)}% / {rate(a.affiliate_commission_rate_lifetime, 0.15)}%
                    </td>
                    <td className="px-6 py-4 font-mono text-sm text-ink">${earnings.accruing.toFixed(2)}</td>
                    <td className="px-6 py-4 font-mono text-sm text-ink">${earnings.awaiting.toFixed(2)}</td>
                    <td className="px-6 py-4 font-mono text-sm text-accent">${earnings.paid.toFixed(2)}</td>
                    <td className="px-6 py-4 text-xs font-mono text-muted">
                      {new Date(a.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-wrap gap-2">
                        <AdminAffiliateActions userId={a.id} action={a.is_verified_operator ? 'revokeVerifiedOperator' : 'grantVerifiedOperator'} />
                        {!a.is_verified_operator && (
                          <AdminAffiliateActions userId={a.id} action="editRates"
                            currentIntro={Number(a.affiliate_commission_rate ?? 0.3)} currentLifetime={Number(a.affiliate_commission_rate_lifetime ?? 0.15)} />
                        )}
                        <AdminAffiliateActions userId={a.id} action="suspendAffiliate" />
                      </div>
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

      {/* Suspended affiliates */}
      {suspendedAffiliates && suspendedAffiliates.length > 0 && (
        <div className="bg-white border border-border rounded-xl overflow-hidden mt-8">
          <div className="px-6 py-4 border-b border-border">
            <h2 className="font-display font-bold text-base text-ink">Suspended affiliates ({suspendedAffiliates.length})</h2>
            <p className="text-xs text-muted mt-1">New referrals don't earn and payouts are skipped. Commissions already earned are kept.</p>
          </div>
          <table className="w-full">
            <tbody>
              {suspendedAffiliates.map((a, i) => {
                const earnings = earningsByAffiliate[a.id] ?? { accruing: 0, awaiting: 0, paid: 0 }
                return (
                  <tr key={a.id} className={i < suspendedAffiliates.length - 1 ? 'border-b border-border' : ''}>
                    <td className="px-6 py-4">
                      <Link href={`/admin/affiliates/${a.id}`} className="text-sm font-medium text-ink hover:text-accent hover:underline">{a.full_name || '—'}</Link>
                      <div className="text-xs font-mono text-muted">{a.email}</div>
                    </td>
                    <td className="px-6 py-4 font-mono text-xs text-muted">${earnings.accruing.toFixed(2)} on hold</td>
                    <td className="px-6 py-4 text-right"><AdminAffiliateActions userId={a.id} action="reinstateAffiliate" /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Recently paid payouts — who sent it and the payment reference */}
      <div className="bg-white border border-border rounded-xl overflow-hidden mt-8">
        <div className="px-6 py-4 border-b border-border">
          <h2 className="font-display font-bold text-base text-ink">Recently paid</h2>
        </div>
        {(paidPayouts ?? []).length === 0 ? (
          <div className="text-center py-10 text-muted text-sm font-light">No payouts have been marked paid yet.</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-surface">
                {['Affiliate', 'Cycle', 'Amount', 'Method', 'Reference', 'Paid'].map(h => (
                  <th key={h} className="text-left px-6 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(paidPayouts ?? []).map((p: any, i: number) => (
                <tr key={p.id} className={i < (paidPayouts?.length ?? 0) - 1 ? 'border-b border-border' : ''}>
                  <td className="px-6 py-3 text-xs font-mono text-ink">{p.referrer?.email ?? '—'}</td>
                  <td className="px-6 py-3 text-xs font-mono text-muted">{formatCycleLabel(p)}</td>
                  <td className="px-6 py-3 font-mono text-sm text-accent">${Number(p.amount_usd).toFixed(2)}</td>
                  <td className="px-6 py-3 text-xs font-mono text-muted">{p.payout_method}</td>
                  <td className="px-6 py-3 text-xs font-mono text-ink break-all">{p.payment_reference ?? '—'}</td>
                  <td className="px-6 py-3 text-xs font-mono text-muted">
                    {p.paid_at ? new Date(p.paid_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
                    {p.payer?.email && <div className="text-[10px]">by {p.payer.email}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
