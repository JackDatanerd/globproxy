import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ReferralLinkCard from '@/components/dashboard/ReferralLinkCard'
import AffiliateApplyForm from '@/components/dashboard/AffiliateApplyForm'
import PayoutMethodForm from '@/components/dashboard/PayoutMethodForm'
import { currentAccruingCycle, formatCycleLabel } from '@/lib/payoutCycle'

export default async function ReferralsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const [{ data: profile }, { data: referrals }] = await Promise.all([
    supabase.from('profiles')
      .select('referral_code, affiliate_status, affiliate_commission_rate, affiliate_commission_rate_lifetime, payout_method, payout_wallet_address, payout_bank_details, payout_mpesa_phone, payout_method_updated_at')
      .eq('id', user.id)
      .single(),
    supabase.from('referrals')
      .select('id, created_at, gb_bonus_credited_at')
      .eq('referrer_id', user.id)
      .order('created_at', { ascending: false }),
  ])

  const isAffiliate = profile?.affiliate_status === 'approved'

  const [{ data: commissions }, { data: payouts }] = isAffiliate
    ? await Promise.all([
        supabase.from('affiliate_commissions')
          .select('id, gross_amount_usd, commission_rate, commission_amount_usd, status, created_at, payout_id')
          .eq('referrer_id', user.id)
          .order('created_at', { ascending: false })
          .limit(20),
        supabase.from('affiliate_payouts')
          .select('id, cycle_start, cycle_end, amount_usd, status, payout_method, created_at, paid_at')
          .eq('referrer_id', user.id)
          .order('cycle_start', { ascending: false }),
      ])
    : [{ data: [] }, { data: [] }]

  const referredCount = referrals?.length ?? 0
  const gbEarned = (referrals ?? []).filter(r => r.gb_bonus_credited_at).length // 1 GB each, per REFERRAL_GB_BONUS

  const allCommissions = commissions ?? []
  const totalPaidUsd = (payouts ?? []).filter(p => p.status === 'paid').reduce((sum, p) => sum + Number(p.amount_usd), 0)

  const cycle = currentAccruingCycle()
  const thisCycleUsd = allCommissions
    .filter(c => !c.payout_id && c.created_at >= cycle.cycleStart && c.created_at.slice(0, 10) <= cycle.cycleEnd)
    .reduce((sum, c) => sum + Number(c.commission_amount_usd), 0)

  return (
    <div className="max-w-3xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">Referrals</h1>
        <p className="text-muted text-sm mt-1">Share GlobProxy, earn free bandwidth — or cash as an affiliate</p>
      </div>

      {profile?.referral_code && <ReferralLinkCard code={profile.referral_code} />}

      <div className={`grid gap-4 mt-4 ${isAffiliate ? 'grid-cols-3' : 'grid-cols-2'}`}>
        <div className="bg-white border border-border rounded-xl p-5">
          <div className="text-[10px] font-mono text-muted uppercase tracking-wider">People referred</div>
          <div className="text-2xl font-display font-bold text-ink mt-1">{referredCount}</div>
        </div>
        {isAffiliate && (
          <div className="bg-white border border-border rounded-xl p-5">
            <div className="text-[10px] font-mono text-muted uppercase tracking-wider">This cycle so far</div>
            <div className="text-2xl font-display font-bold text-ink mt-1">${thisCycleUsd.toFixed(2)}</div>
            <div className="text-[10px] text-muted mt-1">Payable from {new Date(cycle.payableFrom + 'T00:00:00Z').toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</div>
          </div>
        )}
        <div className="bg-white border border-border rounded-xl p-5">
          <div className="text-[10px] font-mono text-muted uppercase tracking-wider">
            {isAffiliate ? 'Total paid to date' : 'GB bonuses earned'}
          </div>
          <div className="text-2xl font-display font-bold text-accent mt-1">
            {isAffiliate ? `$${totalPaidUsd.toFixed(2)}` : `${gbEarned} GB`}
          </div>
        </div>
      </div>

      {isAffiliate && (
        <div className="mt-4">
          <PayoutMethodForm
            currentMethod={profile?.payout_method as 'usdt' | 'bank' | 'mpesa' | null}
            currentWalletAddress={profile?.payout_wallet_address ?? null}
            currentBankDetails={profile?.payout_bank_details as any}
            currentMpesaPhone={profile?.payout_mpesa_phone ?? null}
            updatedAt={profile?.payout_method_updated_at ?? null}
          />
        </div>
      )}

      <div className="mt-4">
        {profile?.affiliate_status === 'approved' ? (
          <div className="flex flex-col gap-4">
            <div className="bg-white border border-border rounded-xl p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-medium text-ink">Payout history</div>
                <span className="text-[10px] font-mono bg-green-50 text-green-600 px-2 py-0.5 rounded-full">
                  {Math.round(Number(profile.affiliate_commission_rate ?? 0.3) * 100)}% intro · {Math.round(Number(profile.affiliate_commission_rate_lifetime ?? 0.15) * 100)}% lifetime
                </span>
              </div>
              {payouts && payouts.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {payouts.map(p => (
                    <div key={p.id} className="flex items-center justify-between text-xs border-b border-border last:border-0 pb-2 last:pb-0">
                      <span className="text-muted">{formatCycleLabel(p)} · {p.payout_method === 'usdt' ? 'USDT' : p.payout_method === 'mpesa' ? 'M-Pesa' : 'Bank'}</span>
                      <span className={`font-mono ${p.status === 'paid' ? 'text-green-600' : 'text-ink'}`}>
                        ${Number(p.amount_usd).toFixed(2)} {p.status === 'paid' ? '· paid' : '· scheduled'}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-muted">
                  No payouts yet — earnings under the $20 minimum or without a payout method on file roll forward automatically until they clear.
                </div>
              )}
            </div>

            <div className="bg-white border border-border rounded-xl p-5">
              <div className="text-sm font-medium text-ink mb-3">Recent commissions</div>
              {allCommissions.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {allCommissions.slice(0, 10).map(c => (
                    <div key={c.id} className="flex items-center justify-between text-xs border-b border-border last:border-0 pb-2 last:pb-0">
                      <span className="text-muted">
                        {new Date(c.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                        {' · '}${Number(c.gross_amount_usd).toFixed(2)} order at {Math.round(Number(c.commission_rate) * 100)}%
                      </span>
                      <span className="font-mono text-ink">
                        ${Number(c.commission_amount_usd).toFixed(2)} {c.payout_id ? '· batched' : '· accruing'}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-muted">No commissions yet — they'll show up here as your referrals order.</div>
              )}
            </div>
          </div>
        ) : profile?.affiliate_status === 'pending' ? (
          <div className="bg-white border border-border rounded-xl p-5">
            <div className="text-sm font-medium text-ink mb-1">Affiliate application pending</div>
            <div className="text-xs text-muted">We'll review it and follow up by email.</div>
          </div>
        ) : profile?.affiliate_status === 'rejected' ? (
          <div className="bg-white border border-border rounded-xl p-5">
            <div className="text-sm font-medium text-ink mb-1">Affiliate application not approved</div>
            <div className="text-xs text-muted">You can still earn the standard GB bonus above. Reach out to support to discuss reapplying.</div>
          </div>
        ) : (
          <AffiliateApplyForm />
        )}
      </div>
    </div>
  )
}
