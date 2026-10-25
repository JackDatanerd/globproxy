import { createClient, createAdminClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import CancelPayoutButton from '@/components/dashboard/CancelPayoutButton'
import ReferralLinkCard from '@/components/dashboard/ReferralLinkCard'
import AffiliateApplyForm from '@/components/dashboard/AffiliateApplyForm'
import PayoutMethodForm from '@/components/dashboard/PayoutMethodForm'
import ClaimReferralForm from '@/components/dashboard/ClaimReferralForm'
import ExportButton from '@/components/dashboard/ExportButton'
import { maskWallet, maskPhone, maskBank } from '@/lib/maskPayout'
import { currentAccruingCycle, lastCompletedCycle, cycleIsPayable, formatCycleLabel } from '@/lib/payoutCycle'
import { formatUsd } from '@/lib/format'
import { getKesQuote } from '@/lib/fx'
import {
  REFERRAL_GB_BONUS, REFERRAL_MIN_ORDER_USD, AFFILIATE_MIN_PAYOUT_USD, AFFILIATE_HOLD_HOURS,
  formatRatePct,
} from '@/lib/referrals'

const FUNNEL_PAGE = 25
const COMMISSION_PAGE = 15
const PAYOUT_PAGE = 24
const usd = formatUsd
const shortDate = (s: string) => new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' })

export default async function ReferralsPage({ searchParams }: { searchParams: Promise<{ page?: string; cpage?: string }> }) {
  const sp = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const page = Math.max(1, Math.min(100_000, parseInt(sp.page ?? '1', 10) || 1))
  const cpage = Math.max(1, Math.min(100_000, parseInt(sp.cpage ?? '1', 10) || 1))
  const accruing = currentAccruingCycle()

  const { data: profile, error: profileErr } = await supabase.from('profiles')
    .select('referral_code, affiliate_status, affiliate_commission_rate, affiliate_commission_rate_lifetime, is_verified_operator, payout_method, payout_wallet_address, payout_bank_details, payout_mpesa_phone, payout_method_updated_at, payout_hold_reason')
    .eq('id', user.id)
    .single()

  const status = profile?.affiliate_status ?? null
  const isAffiliate = status === 'approved'
  // A suspended affiliate still has earnings, payouts and history — hiding them
  // made the page look like the money had vanished. They can read it all; only
  // the actions (payout method, new earnings) are paused.
  const showMoney = isAffiliate || status === 'suspended'

  // Aggregates are computed in SQL (my_affiliate_summary / my_referral_funnel,
  // service-role only, called here with the SESSION's own user id) — summing a client-fetched list silently capped
  // at 1000 rows, and "this cycle so far" used to be summed from only the
  // latest 20 commissions.
  const admin = await createAdminClient()
  const [{ data: summaryRows, error: summaryErr }, { data: funnel, error: funnelErr }, { data: commissions, error: commissionsErr, count: commissionsCount }, { data: payouts, error: payoutsErr, count: payoutsCount }, { count: referredByAnyone, error: referredErr }, { count: purchaseCount, error: purchaseErr }, adjustmentsRes, tagsRes, deductionsRes] = await Promise.all([
    admin.rpc('my_affiliate_summary', { p_user_id: user.id, p_cycle_start: accruing.cycleStart, p_cycle_end: accruing.cycleEnd }),
    admin.rpc('my_referral_funnel', { p_user_id: user.id, p_limit: FUNNEL_PAGE, p_offset: (page - 1) * FUNNEL_PAGE }),
    showMoney
      ? supabase.from('affiliate_commissions')
          .select('id, gross_amount_usd, commission_rate, commission_amount_usd, status, created_at, payout_id', { count: 'exact' })
          .eq('referrer_id', user.id).order('created_at', { ascending: false }).order('id', { ascending: false })
          .range((cpage - 1) * COMMISSION_PAGE, cpage * COMMISSION_PAGE - 1)
      : Promise.resolve({ data: [] as any[], error: null, count: 0 as number | null }),
    // Through the service role, scoped to the signed-in user: the table also holds
    // a snapshot of the payout destination, which the browser-side session can no
    // longer read (migration 0070).
    showMoney
      ? admin.from('affiliate_payouts')
          .select('id, cycle_start, cycle_end, amount_usd, status, payout_method, paid_at, payment_reference, payout_local_amount, payout_local_currency, payout_fx_rate', { count: 'exact' })
          .eq('referrer_id', user.id).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(PAYOUT_PAGE)
      : Promise.resolve({ data: [] as any[], error: null, count: 0 as number | null }),
    // The referred user can't read their own `referrals` row through RLS
    // (policies are referrer/admin only), so this one existence check uses the
    // service role, scoped to the signed-in user's id.
    admin.from('referrals').select('id', { count: 'exact', head: true }).eq('referred_user_id', user.id),
    // "Add a referral code" only works before the first purchase (the server
    // refuses afterwards) — so don't offer it to someone who has already bought.
    admin.from('orders').select('id', { count: 'exact', head: true })
      .eq('user_id', user.id).eq('bandwidth_credited', true).eq('is_canary', false),
    showMoney ? admin.rpc('my_affiliate_adjustments', { p_user_id: user.id }) : Promise.resolve({ data: [] as any[], error: null }),
    showMoney ? admin.rpc('my_referral_tags', { p_user_id: user.id }) : Promise.resolve({ data: [] as any[], error: null }),
    showMoney ? admin.rpc('my_affiliate_open_deductions', { p_user_id: user.id }) : Promise.resolve({ data: 0, error: null }),
  ])

  // profileErr matters most: without the profile an approved affiliate reads as a plain user and is shown the application form.
  const loadFailed = !!(profileErr || referredErr || purchaseErr || summaryErr || funnelErr || commissionsErr || payoutsErr || adjustmentsRes.error || tagsRes.error || deductionsRes.error)
  const s = (summaryRows as any[])?.[0] ?? {}
  // Refund deductions not yet netted into a payout (a commission that was paid
  // and whose order was refunded afterwards). They come off the next payout.
  const adjustments = ((adjustmentsRes.data as any[]) ?? [])
  // From SQL, not from the (50-row) list above, which could understate it.
  const deductions = Number(deductionsRes.data ?? 0)
  const tags = ((tagsRes.data as any[]) ?? [])
  const payable = Number(s.accruing_usd ?? 0) - deductions
  const inPayout = Number(s.in_payout_usd ?? 0)
  // What each payout is made of (commissions, deductions netted off). Best-effort: the
  // page works without it.
  const breakdown = new Map<string, { commissions: number; count: number; deductions: number }>()
  if (showMoney && payouts && payouts.length > 0) {
    const { data: bd, error: bdErr } = await admin.rpc('my_payout_breakdown', { p_user_id: user.id })
    if (bdErr) console.error('[referrals] payout breakdown failed', bdErr.message)
    for (const b of (bd as any[]) ?? []) breakdown.set(b.payout_id, { commissions: Number(b.commissions_usd), count: Number(b.commission_count), deductions: Number(b.deductions_usd) })
  }

  const paidTotal = Number(s.paid_usd ?? 0)
  const thisCycle = Number(s.this_cycle_usd ?? 0)
  const referralCount = Number(s.referral_count ?? 0)
  const convertedCount = Number(s.converted_count ?? 0)
  const clicks = Number(s.clicks_total ?? 0)
  const bonusGb = Number(s.bonus_gb_total ?? 0)
  const flaggedCount = Number(s.flagged_count ?? 0)

  const lc = lastCompletedCycle()
  // Payouts are created when a run is made, not on the payable date itself. Once the last
  // completed cycle is payable and this affiliate has a payable balance, a method on file
  // and no hold, their money is simply waiting for that run — saying "next run: <the
  // following cycle>" made it look skipped.
  const holdPending = !!profile?.payout_method_updated_at && !!profile?.payout_method
    && new Date(profile.payout_method_updated_at).getTime() + AFFILIATE_HOLD_HOURS * 3600 * 1000 > Date.now()
  const awaitingRun = cycleIsPayable(lc) && isAffiliate && !!profile?.payout_method && !holdPending && payable >= AFFILIATE_MIN_PAYOUT_USD
  const nextPayoutDate = cycleIsPayable(lc) ? accruing.payableFrom : lc.payableFrom
  const holdEndsAt = profile?.payout_method_updated_at
    ? new Date(new Date(profile.payout_method_updated_at).getTime() + AFFILIATE_HOLD_HOURS * 3600 * 1000)
    : null
  const holdActive = !!holdEndsAt && holdEndsAt.getTime() > Date.now()
  const belowMin = payable < AFFILIATE_MIN_PAYOUT_USD
  const minProgress = Math.max(0, Math.min(100, (payable / AFFILIATE_MIN_PAYOUT_USD) * 100))

  const funnelRows = (funnel as any[]) ?? []
  const funnelTotal = Number(funnelRows[0]?.total_count ?? 0)
  const funnelPages = Math.max(1, Math.ceil(funnelTotal / FUNNEL_PAGE))
  const commissionPages = Math.max(1, Math.ceil(Number(commissionsCount ?? 0) / COMMISSION_PAGE))
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://globproxy.com'

  const commissionState = (c: any) => {
    if (c.status === 'void') return 'reversed'
    if (c.status === 'paid') return 'paid'
    if (c.payout_id) return 'scheduled'
    return 'payable'
  }

  // M-Pesa affiliates are paid in KES at the market rate on the day it is sent; show an
  // indicative figure so the USD amount is not the only thing they can see. Best-effort.
  let kesPayable: number | null = null
  if (isAffiliate && profile?.payout_method === 'mpesa' && payable > 0) {
    try {
      const q = await getKesQuote(admin)
      if (q) kesPayable = Math.round(payable * q.market)
    } catch { /* no rate right now: the USD figure stands alone */ }
  }

  return (
    <div className="max-w-3xl">
      {loadFailed && (
        <div className="mb-5 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
          Some of your referral data couldn&apos;t be loaded, so the figures below may be incomplete. Refresh to try again.
        </div>
      )}
      <div className="mb-8">
        <div className="flex items-center gap-2.5">
          <h1 className="font-display font-bold text-2xl text-ink">Referrals</h1>
          {profile?.is_verified_operator && (
            <span className="text-xs font-mono bg-accent2/10 text-accent2 px-2.5 py-1 rounded-full">✓ Verified Operator</span>
          )}
        </div>
        <p className="text-muted text-sm mt-1">Share GlobProxy, earn free bandwidth — or cash as an affiliate</p>
      </div>

      {profile?.referral_code && (
        <ReferralLinkCard code={profile.referral_code} baseUrl={baseUrl} isAffiliate={isAffiliate} suspended={status === 'suspended'}
          bonusGb={REFERRAL_GB_BONUS} minOrderUsd={REFERRAL_MIN_ORDER_USD} />
      )}

      <div className={`grid gap-4 mt-4 ${showMoney ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-1 sm:grid-cols-3'}`}>
        <Tile label="Link clicks" value={String(clicks)} />
        <Tile label="Signed up" value={String(referralCount)} sub={`${convertedCount} purchased`} />
        {showMoney ? (
          <>
            <Tile label="Payable" value={usd(Math.max(payable, 0))} accent sub={(deductions > 0 ? `after ${usd(deductions)} of refund deductions` : 'awaiting the next payout run') + (kesPayable !== null ? ` · ≈ KES ${kesPayable.toLocaleString('en-US')} today` : '')} />
            <Tile label="Paid to date" value={usd(paidTotal)} sub={inPayout > 0 ? `${usd(inPayout)} scheduled` : undefined} />
          </>
        ) : (
          <Tile label="GB bonuses earned" value={`${bonusGb} GB`} accent />
        )}
      </div>

      {showMoney && (
        <div className="bg-white border border-border rounded-xl p-5 mt-4">
          <div className="flex items-center justify-between text-xs mb-2">
            <span className="text-ink font-medium">
              {belowMin ? `${usd(Math.max(payable, 0))} of ${usd(AFFILIATE_MIN_PAYOUT_USD)} minimum` : 'Above the payout minimum'}
            </span>
            <span className="text-muted">{awaitingRun ? `Payable since ${shortDate(lc.payableFrom + 'T00:00:00Z')} — your payout is created at the next payout run` : `Next payout run: ${shortDate(nextPayoutDate + 'T00:00:00Z')}`} · this cycle so far {usd(thisCycle)}</span>
          </div>
          <div className="h-1.5 bg-surface rounded-full overflow-hidden">
            <div className="h-full bg-accent2 rounded-full" style={{ width: `${minProgress}%` }} />
          </div>
          <ul className="text-[11px] text-muted mt-3 space-y-1 list-disc pl-4">
            <li>If a referred order is refunded, its commission is reduced to match. If that commission was already paid out, the amount is deducted from your next payout{deductions > 0 ? ` (${usd(deductions)} is waiting to be deducted now)` : ''} — you are never billed separately.</li>
            <li>Anything under the {usd(AFFILIATE_MIN_PAYOUT_USD)} minimum, or earned before you add a payout method, stays in your balance and is paid in the first run where it qualifies.</li>
            {flaggedCount > 0 && <li>Referrals marked “under review” in the table below are being verified and aren&apos;t earning yet. If you think one was held by mistake, email support@globproxy.com with the signup address.</li>}
          </ul>
        </div>
      )}

      {isAffiliate && holdActive && !!profile?.payout_method && (
        <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 text-xs rounded-xl p-4 mt-4">
          {profile?.payout_hold_reason === 'security_event'
            ? 'A recent change to your account security (password, email address or two-step verification)'
            : profile?.payout_hold_reason === 'method_changed'
              ? 'Your payout details changed recently, so payouts'
              : 'Your payout details or account security settings changed recently, so payouts'}
          {profile?.payout_hold_reason === 'security_event' ? ' put payouts on a ' : ' are on a '}{AFFILIATE_HOLD_HOURS}-hour security hold until{' '}
          <strong>{holdEndsAt!.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC</strong>.
          If you didn&apos;t make that change, contact support now.
        </div>
      )}

      {isAffiliate && (
        <div className="mt-4">
          <PayoutMethodForm
            currentMethod={profile?.payout_method as 'usdt' | 'bank' | 'mpesa' | null}
            currentWalletAddress={maskWallet(profile?.payout_wallet_address)}
            currentBankDetails={maskBank(profile?.payout_bank_details)}
            currentMpesaPhone={maskPhone(profile?.payout_mpesa_phone)}
            // "Last changed" is about the payout method itself; an account-security hold is explained by the banner above.
            updatedAt={profile?.payout_hold_reason === 'security_event' ? null : profile?.payout_method_updated_at ?? null}
            holdHours={AFFILIATE_HOLD_HOURS}
          />
        </div>
      )}

      {!referredErr && !purchaseErr && !profileErr && !referredByAnyone && !purchaseCount && <ClaimReferralForm />}

      <div className="mt-4">
        {showMoney ? (
          <div className="flex flex-col gap-4">
            {status === 'suspended' && (
              <div className="bg-white border border-red-200 rounded-xl p-5">
                <div className="text-sm font-medium text-ink mb-1">Affiliate access suspended</div>
                <div className="text-xs text-muted">New referrals aren&apos;t earning commission and payouts are paused. Your history is below. Contact support@globproxy.com to discuss.</div>
              </div>
            )}
            <div className="bg-white border border-border rounded-xl p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-medium text-ink">Payout history</div>
                <span className="text-[10px] font-mono bg-green-50 text-green-600 px-2 py-0.5 rounded-full">
                  {formatRatePct(profile?.affiliate_commission_rate ?? 0.3)} intro · {formatRatePct(profile?.affiliate_commission_rate_lifetime ?? 0.15)} lifetime
                </span>
              </div>
              {payouts && payouts.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {payouts.map((p: any) => (
                    <div key={p.id} className="text-xs border-b border-border last:border-0 pb-2 last:pb-0">
                      <div className="flex items-center justify-between">
                        <span className="text-muted">{formatCycleLabel(p)} · {p.payout_method === 'usdt' ? 'USDT' : p.payout_method === 'mpesa' ? 'M-Pesa' : 'Bank'}</span>
                        <span className={`font-mono ${p.status === 'paid' ? 'text-green-600' : 'text-ink'}`}>
                          {usd(Number(p.amount_usd))} {p.status === 'paid' ? '· paid' : '· scheduled'}
                        </span>
                      </div>
                      {p.status === 'paid' && p.payment_reference && (
                        <div className="text-[10px] font-mono text-muted mt-0.5 break-all">ref {p.payment_reference}</div>
                      )}
                      {p.payout_method === 'mpesa' && p.status === 'paid' && p.payout_local_amount != null && (
                        <div className="text-[10px] font-mono text-muted mt-0.5">sent as KES {Number(p.payout_local_amount).toLocaleString('en-US')} at {Number(p.payout_fx_rate).toFixed(2)} KES per USD</div>
                      )}
                      {breakdown.get(p.id) && (
                        <div className="text-[10px] text-muted mt-0.5">
                          {breakdown.get(p.id)!.count} commission{breakdown.get(p.id)!.count === 1 ? '' : 's'} {usd(breakdown.get(p.id)!.commissions)}
                          {breakdown.get(p.id)!.deductions > 0 ? ` − ${usd(breakdown.get(p.id)!.deductions)} refund deductions` : ''}
                        </div>
                      )}
                      {p.status === 'pending' && isAffiliate && <div className="mt-1"><CancelPayoutButton payoutId={p.id} /></div>}
                    </div>
                  ))}
                  {Number(payoutsCount ?? 0) > PAYOUT_PAGE && (
                    <div className="text-[10px] text-muted pt-1">Showing your latest {PAYOUT_PAGE} of {payoutsCount}. The full history is in the Payouts CSV below.</div>
                  )}
                </div>
              ) : (
                <div className="text-xs text-muted">No payouts yet — your first one is created once your payable balance reaches {usd(AFFILIATE_MIN_PAYOUT_USD)} with a payout method on file.</div>
              )}
            </div>

            {adjustments.length > 0 && (
              <div className="bg-white border border-border rounded-xl p-5">
                <div className="text-sm font-medium text-ink mb-1">Refund deductions</div>
                <div className="text-[11px] text-muted mb-3">When an order behind a commission we already paid is refunded, the commission is recovered by deducting it from your next payout.</div>
                <div className="flex flex-col gap-2">
                  {adjustments.map((a: any) => (
                    <div key={a.id} className="flex items-center justify-between text-xs border-b border-border last:border-0 pb-2 last:pb-0">
                      <span className="text-muted">
                        {new Date(a.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                        {' · '}{a.reason === 'refund_after_paid' ? 'refund after payout' : 'adjustment'}
                      </span>
                      <span className={`font-mono ${a.waived ? 'text-muted line-through' : 'text-ink'}`}>
                        {usd(Number(a.amount_usd))} · {a.waived ? 'waived' : a.settled ? 'deducted' : 'pending'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tags.length > 0 && (
              <div className="bg-white border border-border rounded-xl p-5">
                <div className="text-sm font-medium text-ink mb-1">Campaign tags</div>
                <div className="text-[11px] text-muted mb-3">Add <span className="font-mono">?sub=your-tag</span> to your link to see which campaign brings clicks, signups and sales.</div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-[10px] font-mono text-muted uppercase tracking-wider">
                        <th className="pb-2 pr-3">Tag</th><th className="pb-2 pr-3 text-right">Clicks</th><th className="pb-2 pr-3 text-right">Signups</th>
                        <th className="pb-2 pr-3 text-right">Purchased</th><th className="pb-2 text-right">Earned</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tags.map((t: any) => (
                        <tr key={t.sub_id} className="border-t border-border">
                          <td className="py-2 pr-3 font-mono text-ink">{t.sub_id}</td>
                          <td className="py-2 pr-3 text-right font-mono">{Number(t.clicks)}</td>
                          <td className="py-2 pr-3 text-right font-mono">{Number(t.signups)}</td>
                          <td className="py-2 pr-3 text-right font-mono">{Number(t.converted)}</td>
                          <td className="py-2 text-right font-mono text-ink">{usd(Number(t.earned_usd))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="bg-white border border-border rounded-xl p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-medium text-ink">Commissions <span className="text-muted font-mono font-normal">({Number(commissionsCount ?? 0)})</span></div>
                <div className="flex gap-3 text-[11px] font-mono">
                  <ExportButton url="/api/dashboard/referrals/export?dataset=commissions" filename="globproxy-commissions.csv" className="text-accent hover:underline">Export CSV ↓</ExportButton>
                  <ExportButton url="/api/dashboard/referrals/export?dataset=payouts" filename="globproxy-payouts.csv" className="text-accent hover:underline">Payouts CSV ↓</ExportButton>
                </div>
              </div>
              {commissions && commissions.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {commissions.map((c: any) => {
                    const st = commissionState(c)
                    const net = Number(c.commission_amount_usd)
                    return (
                      <div key={c.id} className="flex items-center justify-between text-xs border-b border-border last:border-0 pb-2 last:pb-0">
                        <span className="text-muted">
                          {new Date(c.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                          {' · '}{usd(Number(c.gross_amount_usd))} order at {formatRatePct(c.commission_rate)}
                        </span>
                        <span className={`font-mono ${st === 'reversed' ? 'text-red-500 line-through' : 'text-ink'}`}>
                          {usd(net)} · {st}
                        </span>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="text-xs text-muted">
                  {cpage > 1 ? 'No commissions on this page.' : 'No commissions yet — they\u2019ll show up here as your referrals order.'}
                </div>
              )}
              {commissionPages > 1 && (
                <div className="flex items-center justify-between mt-4 text-xs font-mono text-muted">
                  {cpage > 1 ? <Link href={`/dashboard/referrals?cpage=${cpage - 1}${page > 1 ? `&page=${page}` : ''}`} className="text-accent hover:underline">← Newer</Link> : <span />}
                  <span>Page {cpage} of {commissionPages}</span>
                  {cpage < commissionPages ? <Link href={`/dashboard/referrals?cpage=${cpage + 1}${page > 1 ? `&page=${page}` : ''}`} className="text-accent hover:underline">Older →</Link> : <span />}
                </div>
              )}
            </div>
          </div>
        ) : status === 'pending' ? (
          <div className="bg-white border border-border rounded-xl p-5">
            <div className="text-sm font-medium text-ink mb-1">Affiliate application pending</div>
            <div className="text-xs text-muted">We&apos;ll review it and follow up by email.</div>
          </div>
        ) : status === 'rejected' ? (
          <div className="bg-white border border-border rounded-xl p-5">
            <div className="text-sm font-medium text-ink mb-1">Affiliate application not approved</div>
            <div className="text-xs text-muted mb-3">You can still earn the standard GB bonus above, and you&apos;re welcome to apply again 7 days after your last application.</div>
            <AffiliateApplyForm />
          </div>
        ) : profileErr ? null : (
          <AffiliateApplyForm />
        )}
      </div>

      {funnelRows.length === 0 && page > 1 && (
        <div className="bg-white border border-border rounded-xl p-5 mt-4 text-xs text-muted">
          No referrals on this page.{' '}
          <Link href="/dashboard/referrals" className="text-accent hover:underline">Back to the first page →</Link>
        </div>
      )}

      {funnelRows.length > 0 && (
        <div className="bg-white border border-border rounded-xl p-5 mt-4">
          <div className="text-sm font-medium text-ink mb-3">Your referrals <span className="text-muted font-mono font-normal">({funnelTotal})</span></div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] font-mono text-muted uppercase tracking-wider">
                  <th className="pb-2 pr-3">Who</th><th className="pb-2 pr-3">Joined</th>
                  {showMoney && <th className="pb-2 pr-3">Tag</th>}
                  <th className="pb-2 pr-3">First purchase</th><th className="pb-2 pr-3 text-right">Orders</th>
                  <th className="pb-2 text-right">{showMoney ? 'Earned' : 'Bonus'}</th>
                </tr>
              </thead>
              <tbody>
                {funnelRows.map((r: any, i: number) => (
                  <tr key={i} className="border-t border-border">
                    <td className="py-2 pr-3 font-mono text-ink">
                      {r.referred_label}
                      {r.flagged && <span className="ml-2 text-[9px] font-mono bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded-full">under review</span>}
                    </td>
                    <td className="py-2 pr-3 text-muted whitespace-nowrap">{shortDate(r.joined_at)}</td>
                    {showMoney && <td className="py-2 pr-3 font-mono text-muted">{r.sub_id ?? '—'}</td>}
                    <td className="py-2 pr-3 text-muted whitespace-nowrap">{r.first_purchase_at ? shortDate(r.first_purchase_at) : '—'}</td>
                    <td className="py-2 pr-3 text-right font-mono">{Number(r.orders_count)}</td>
                    <td className="py-2 text-right font-mono text-ink">
                      {showMoney ? usd(Number(r.earned_usd)) : (r.bonus_credited ? `${REFERRAL_GB_BONUS} GB` : r.bonus_reversed ? 'reversed (refund)' : '—')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {funnelPages > 1 && (
            <div className="flex items-center justify-between mt-4 text-xs font-mono text-muted">
              {page > 1 ? <Link href={`/dashboard/referrals?page=${page - 1}${cpage > 1 ? `&cpage=${cpage}` : ''}`} className="text-accent hover:underline">← Newer</Link> : <span />}
              <span>Page {page} of {funnelPages}</span>
              {page < funnelPages ? <Link href={`/dashboard/referrals?page=${page + 1}${cpage > 1 ? `&cpage=${cpage}` : ''}`} className="text-accent hover:underline">Older →</Link> : <span />}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Tile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className="bg-white border border-border rounded-xl p-5">
      <div className="text-[10px] font-mono text-muted uppercase tracking-wider">{label}</div>
      <div className={`text-2xl font-display font-bold mt-1 ${accent ? 'text-accent' : 'text-ink'}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted mt-1">{sub}</div>}
    </div>
  )
}
