import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/server'
import AdminAffiliateActions from '@/components/admin/AdminAffiliateActions'
import RunPayoutCycleButton from '@/components/admin/RunPayoutCycleButton'
import ExportPayoutsButton from '@/components/admin/ExportPayoutsButton'
import { getKesQuote } from '@/lib/fx'
import { maskWallet, maskPhone, maskBank } from '@/lib/maskPayout'
import AdminPendingPayouts, { type PendingPayoutRow } from '@/components/admin/AdminPendingPayouts'
import AdminPager, { parsePage, cleanSearch } from '@/components/admin/AdminPager'
import { formatCycleLabel } from '@/lib/payoutCycle'
import { formatRatePct, DEFAULT_AFFILIATE_INTRO_RATE, DEFAULT_AFFILIATE_LIFETIME_RATE, verifiedOperatorReviewDue } from '@/lib/rates'
import { listVerifiedOperatorsDue } from '@/lib/adminVo'
import AdminVerifiedOperatorReview from '@/components/admin/AdminVerifiedOperatorReview'

const PAGE_SIZE = 50
const LIST_CAP = 100      // pending applications / suspended affiliates shown at once
const PAYOUT_CAP = 500    // pending payouts shown at once

export default async function AdminAffiliatesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const page = parsePage(sp.page)
  const q = cleanSearch(sp.q)
  const dueOnly = sp.due === '1'
  const voOnly = sp.vo === '1' || dueOnly

  const supabase = await createAdminClient()
  // Deleted accounts keep their affiliate_status on the '[deleted]' tombstone,
  // so every list excludes is_deleted. 'suspended' affiliates get their own
  // section (status can now be set by /api/admin/suspend-affiliate).
  // Active affiliates are paged / searchable / filterable: this list used to be
  // one unbounded fetch (silently cut off at PostgREST's 1000 rows) of every
  // column on the profile.
  const from = (page - 1) * PAGE_SIZE
  let activeQuery = supabase.from('profiles')
    .select('id, full_name, email, created_at, is_verified_operator, verified_operator_since, affiliate_commission_rate, affiliate_commission_rate_lifetime', { count: 'exact' })
    .eq('affiliate_status', 'approved').eq('is_deleted', false)
  if (voOnly) activeQuery = activeQuery.eq('is_verified_operator', true)
  if (dueOnly) {
    // Only the operators whose review is overdue (the Overview tile links here).
    const due = await listVerifiedOperatorsDue(supabase)
    activeQuery = activeQuery.in('id', due.ids.length ? due.ids : ['00000000-0000-0000-0000-000000000000'])
  }
  if (q) activeQuery = activeQuery.or(`email.ilike.%${q}%,full_name.ilike.%${q}%`)

  const [
    { data: applicants, count: applicantCount },
    { data: affiliates, count: activeCount, error: activeErr },
    { data: suspendedAffiliates, count: suspendedCount },
    { data: pendingPayouts, count: pendingPayoutCount, error: payoutsErr },
    { data: paidPayouts },
    { count: totalActive },
    { count: totalVo },
  ] = await Promise.all([
    supabase.from('profiles').select('id, full_name, email, affiliate_application, created_at', { count: 'exact' }).eq('affiliate_status', 'pending').eq('is_deleted', false).order('created_at', { ascending: false }).limit(LIST_CAP),
    activeQuery.order('created_at', { ascending: false }).range(from, from + PAGE_SIZE - 1),
    supabase.from('profiles').select('id, full_name, email, is_verified_operator', { count: 'exact' }).eq('affiliate_status', 'suspended').eq('is_deleted', false).order('created_at', { ascending: false }).limit(LIST_CAP),
    supabase.from('affiliate_payouts').select('*, referrer:referrer_id(email, full_name, is_deleted, is_suspended, affiliate_status)', { count: 'exact' }).eq('status', 'pending').order('cycle_start', { ascending: false }).limit(PAYOUT_CAP),
    supabase.from('affiliate_payouts').select('id, amount_usd, cycle_start, cycle_end, payout_method, paid_at, payment_reference, referrer:referrer_id(email, full_name), payer:paid_by(email)').eq('status', 'paid').order('paid_at', { ascending: false }).limit(15),
    supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('affiliate_status', 'approved').eq('is_deleted', false),
    supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('affiliate_status', 'approved').eq('is_deleted', false).eq('is_verified_operator', true),
  ])
  // Per-affiliate totals computed in SQL (migrations 0043 / 0067) — only for the
  // affiliates on screen, not by pulling every commission row through a giant
  // `.in()` filter.
  const shownIds = [...(affiliates ?? []), ...(suspendedAffiliates ?? [])].map(a => a.id)
  const earningsRes = shownIds.length > 0
    ? await supabase.rpc('admin_affiliate_earnings', { p_referrer_ids: shownIds })
    : { data: [] as unknown[] }

  // Verified Operators due a periodic review (migration 0073). If the reviews table is
  // missing the query errors and nothing is flagged — the list still renders.
  const voIds = (affiliates ?? []).filter((a: any) => a.is_verified_operator).map((a: any) => a.id)
  const { data: voReviews } = voIds.length > 0
    ? await supabase.from('verified_operator_reviews').select('user_id, reviewed_at').in('user_id', voIds).order('reviewed_at', { ascending: false })
    : { data: [] as { user_id: string; reviewed_at: string }[] }
  const lastReview = new Map<string, string>()
  for (const r of (voReviews ?? [])) if (!lastReview.has(r.user_id)) lastReview.set(r.user_id, r.reviewed_at)
  const reviewOverdue = (a: any): boolean => {
    const due = a.is_verified_operator ? verifiedOperatorReviewDue(a.verified_operator_since, lastReview.get(a.id)) : null
    return !!due && due.getTime() < Date.now()
  }

  const earningsByAffiliate: Record<string, { accruing: number; awaiting: number; paid: number }> = {}
  for (const e of (earningsRes.data ?? []) as { referrer_id: string; accruing_usd: number; awaiting_usd: number; paid_usd: number }[]) {
    earningsByAffiliate[e.referrer_id] = { accruing: Number(e.accruing_usd), awaiting: Number(e.awaiting_usd), paid: Number(e.paid_usd) }
  }
  // formatRatePct keeps fractional rates exact (12.5% used to print as 13%).
  const rate = (v: unknown, def: number) => formatRatePct(Number(v ?? def))
  // One market-rate lookup for the whole table (M-Pesa payouts are paid in shillings).
  // null when the rate is unavailable — the table then simply shows USD.
  const hasMpesa = (pendingPayouts ?? []).some((p: any) => p.payout_method === 'mpesa')
  let kesMarket: number | null = null
  if (hasMpesa) { try { kesMarket = (await getKesQuote(supabase as any))?.market ?? null } catch { kesMarket = null } }
  const payoutRows: PendingPayoutRow[] = (pendingPayouts ?? []).map((p: any) => ({
    id: p.id,
    referrerId: p.referrer_id,
    name: p.referrer?.full_name ?? '',
    email: p.referrer?.email ?? '',
    deleted: !!p.referrer?.is_deleted,
    suspended: !!(p.referrer?.is_suspended || p.referrer?.affiliate_status === 'suspended'),
    cycle: formatCycleLabel(p),
    amountUsd: Number(p.amount_usd),
    method: p.payout_method,
    kesIndicative: p.payout_method === 'mpesa' && kesMarket ? Math.round(Number(p.amount_usd) * kesMarket) : null,
    // MASKED on purpose: this object is serialised into the page, so a full wallet / phone /
    // account number here was readable by an admin session that had passed the MFA check but
    // never re-authenticated — while the payouts CSV (the place the full destination is
    // needed to actually send the money) requires a fresh step-up. Same masks as the
    // affiliate detail page and the customer's own referrals page (lib/maskPayout.ts).
    destination: p.referrer?.is_deleted ? null
      : p.payout_method === 'usdt' ? { title: 'USDT (TRC20)', detail: maskWallet(p.payout_wallet_address) ?? 'not recorded' }
      : p.payout_method === 'mpesa' ? { title: 'M-Pesa', detail: maskPhone(p.payout_mpesa_phone) ?? 'not recorded' }
      : { title: maskBank(p.payout_bank_details)?.bankName ?? 'Bank transfer', detail: maskBank(p.payout_bank_details)?.accountLast4 ? `····${maskBank(p.payout_bank_details)!.accountLast4}` : 'not recorded' },
  }))

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

      {(activeErr || payoutsErr) && (
        <div className="mb-6 text-xs bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-2">
          Some of this page could not be loaded ({[activeErr && 'affiliates', payoutsErr && 'pending payouts'].filter(Boolean).join(', ')}). What is empty below may not really be empty — reload before acting on it.
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {([
          ['Active affiliates', totalActive ?? 0],
          ['Verified Operators', totalVo ?? 0],
          ['Pending applications', applicantCount ?? 0],
          ['Suspended', suspendedCount ?? 0],
        ] as [string, number][]).map(([l, v]) => (
          <div key={l} className="bg-white border border-border rounded-xl p-4">
            <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-1">{l}</div>
            <div className="font-display text-xl font-bold text-ink">{v.toLocaleString()}</div>
          </div>
        ))}
      </div>

      {/* Pending applications */}
      {applicants && applicants.length > 0 && (
        <div className="mb-8">
          <h2 className="font-display font-bold text-base text-ink mb-3">
            Pending applications
            <span className="ml-2 text-xs font-mono bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full">
              {applicantCount ?? applicants.length}
            </span>
          </h2>
          {(applicantCount ?? 0) > applicants.length && (
            <p className="text-xs text-muted mb-2">Showing the newest {applicants.length} — approve or reject some to see the rest.</p>
          )}
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
                {pendingPayoutCount ?? pendingPayouts.length}
              </span>
            )}
          </h2>
          <div className="flex items-center gap-2">
            <ExportPayoutsButton status="pending" />
            <RunPayoutCycleButton />
          </div>
        </div>
        {(pendingPayoutCount ?? 0) > payoutRows.length && (
          <div className="mb-3 text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-4 py-2">
            Showing the newest {payoutRows.length} of {(pendingPayoutCount ?? 0).toLocaleString()} pending payouts — mark some paid to see the rest.
          </div>
        )}
        {payoutRows.length > 0 ? (
          <AdminPendingPayouts rows={payoutRows} />
        ) : (
          <div className="bg-white border border-border rounded-xl p-10 text-center text-muted text-sm font-light">
            No pending payouts — run a cycle above to batch this period&apos;s commissions.
          </div>
        )}
      </div>

      {/* Active affiliates */}
      <div className="bg-white border border-border rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-border flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display font-bold text-base text-ink">
            Active affiliates ({(activeCount ?? 0).toLocaleString()}{q || voOnly ? ' matching' : ''})
          </h2>
          <form method="get" className="flex flex-wrap items-center gap-2">
            <input name="q" defaultValue={q} placeholder="Search email or name…"
              className="w-56 bg-white border border-border px-3 py-1.5 rounded-lg text-xs focus:outline-none focus:border-accent" />
            <label className="flex items-center gap-1.5 text-xs font-mono text-ink2">
              <input type="checkbox" name="vo" value="1" defaultChecked={sp.vo === '1'} /> Verified Operators only
            </label>
            <label className="flex items-center gap-1.5 text-xs font-mono text-ink2">
              <input type="checkbox" name="due" value="1" defaultChecked={dueOnly} /> Review due
            </label>
            <button className="text-xs font-mono px-3 py-1.5 rounded-lg border border-border text-ink2 hover:border-ink2">Filter</button>
            {(q || voOnly) && <Link href="/admin/affiliates" className="text-xs font-mono px-2 py-1.5 text-muted hover:text-ink">Clear</Link>}
          </form>
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
                          <span className="text-[10px] font-mono bg-accent2/10 text-accent2 px-2 py-0.5 rounded-full">
                            ✓ Verified Operator{a.verified_operator_since ? ` · since ${new Date(a.verified_operator_since).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}` : ''}
                          </span>
                        )}
                        {reviewOverdue(a) && (
                          <span className="text-[10px] font-mono bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full">review due</span>
                        )}
                      </div>
                      <div className="text-xs font-mono text-muted">{a.email}</div>
                    </td>
                    <td className="px-6 py-4 font-mono text-sm text-ink">
                      {rate(a.affiliate_commission_rate, DEFAULT_AFFILIATE_INTRO_RATE)} / {rate(a.affiliate_commission_rate_lifetime, DEFAULT_AFFILIATE_LIFETIME_RATE)}
                    </td>
                    <td className="px-6 py-4 font-mono text-sm text-ink">${earnings.accruing.toFixed(2)}</td>
                    <td className="px-6 py-4 font-mono text-sm text-ink">${earnings.awaiting.toFixed(2)}</td>
                    <td className="px-6 py-4 font-mono text-sm text-accent">${earnings.paid.toFixed(2)}</td>
                    <td className="px-6 py-4 text-xs font-mono text-muted">
                      {new Date(a.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-wrap gap-2">
                        {reviewOverdue(a) && <AdminVerifiedOperatorReview userId={a.id} />}
                        <AdminAffiliateActions userId={a.id} action={a.is_verified_operator ? 'revokeVerifiedOperator' : 'grantVerifiedOperator'} />
                        {!a.is_verified_operator && (
                          <AdminAffiliateActions userId={a.id} action="editRates"
                            currentIntro={Number(a.affiliate_commission_rate ?? DEFAULT_AFFILIATE_INTRO_RATE)} currentLifetime={Number(a.affiliate_commission_rate_lifetime ?? DEFAULT_AFFILIATE_LIFETIME_RATE)} />
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
          <div className="text-center py-14 text-muted text-sm font-light">{dueOnly ? 'No Verified Operator reviews are due.' : q || voOnly ? 'No affiliates match.' : 'No approved affiliates yet.'}</div>
        )}
      </div>
      <AdminPager basePath="/admin/affiliates" page={page} pageSize={PAGE_SIZE} total={activeCount ?? 0} params={{ q, vo: sp.vo === '1' ? '1' : '', due: dueOnly ? '1' : '' }} />

      {/* Suspended affiliates */}
      {suspendedAffiliates && suspendedAffiliates.length > 0 && (
        <div className="bg-white border border-border rounded-xl overflow-hidden mt-8">
          <div className="px-6 py-4 border-b border-border">
            <h2 className="font-display font-bold text-base text-ink">Suspended affiliates ({(suspendedCount ?? suspendedAffiliates.length).toLocaleString()})</h2>
            <p className="text-xs text-muted mt-1">New referrals don't earn and payouts are skipped. Commissions already earned are kept.{(suspendedCount ?? 0) > suspendedAffiliates.length ? ` Showing the newest ${suspendedAffiliates.length}.` : ''}</p>
          </div>
          <table className="w-full">
            <tbody>
              {suspendedAffiliates.map((a, i) => {
                const earnings = earningsByAffiliate[a.id] ?? { accruing: 0, awaiting: 0, paid: 0 }
                return (
                  <tr key={a.id} className={i < suspendedAffiliates.length - 1 ? 'border-b border-border' : ''}>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <Link href={`/admin/affiliates/${a.id}`} className="text-sm font-medium text-ink hover:text-accent hover:underline">{a.full_name || '—'}</Link>
                        {a.is_verified_operator && <span className="text-[10px] font-mono bg-accent2/10 text-accent2 px-2 py-0.5 rounded-full">✓ Verified Operator</span>}
                      </div>
                      <div className="text-xs font-mono text-muted">{a.email}</div>
                    </td>
                    <td className="px-6 py-4 font-mono text-xs text-muted">${earnings.accruing.toFixed(2)} on hold</td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex gap-2 justify-end">
                        {/* A suspended Verified Operator could not be revoked from the UI before. */}
                        {a.is_verified_operator && <AdminAffiliateActions userId={a.id} action="revokeVerifiedOperator" />}
                        <AdminAffiliateActions userId={a.id} action="reinstateAffiliate" />
                      </div>
                    </td>
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
