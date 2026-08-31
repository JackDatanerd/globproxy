import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ReferralLinkCard from '@/components/dashboard/ReferralLinkCard'
import AffiliateApplyForm from '@/components/dashboard/AffiliateApplyForm'

export default async function ReferralsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const [{ data: profile }, { data: referrals }] = await Promise.all([
    supabase.from('profiles')
      .select('referral_code, affiliate_status, affiliate_commission_rate, affiliate_commission_rate_lifetime')
      .eq('id', user.id)
      .single(),
    supabase.from('referrals')
      .select('id, created_at, gb_bonus_credited_at')
      .eq('referrer_id', user.id)
      .order('created_at', { ascending: false }),
  ])

  const isAffiliate = profile?.affiliate_status === 'approved'

  const { data: commissions } = isAffiliate
    ? await supabase.from('affiliate_commissions')
        .select('id, gross_amount_usd, commission_rate, commission_amount_usd, status, created_at')
        .eq('referrer_id', user.id)
        .order('created_at', { ascending: false })
    : { data: [] }

  const referredCount = referrals?.length ?? 0
  const gbEarned = (referrals ?? []).filter(r => r.gb_bonus_credited_at).length // 1 GB each, per REFERRAL_GB_BONUS
  const totalEarnedUsd = (commissions ?? []).reduce((sum, c) => sum + Number(c.commission_amount_usd), 0)

  return (
    <div className="max-w-3xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">Referrals</h1>
        <p className="text-muted text-sm mt-1">Share GlobProxy, earn free bandwidth — or cash as an affiliate</p>
      </div>

      {profile?.referral_code && <ReferralLinkCard code={profile.referral_code} />}

      <div className="grid grid-cols-2 gap-4 mt-4">
        <div className="bg-white border border-border rounded-xl p-5">
          <div className="text-[10px] font-mono text-muted uppercase tracking-wider">People referred</div>
          <div className="text-2xl font-display font-bold text-ink mt-1">{referredCount}</div>
        </div>
        <div className="bg-white border border-border rounded-xl p-5">
          <div className="text-[10px] font-mono text-muted uppercase tracking-wider">
            {isAffiliate ? 'Total earned' : 'GB bonuses earned'}
          </div>
          <div className="text-2xl font-display font-bold text-accent mt-1">
            {isAffiliate ? `$${totalEarnedUsd.toFixed(2)}` : `${gbEarned} GB`}
          </div>
        </div>
      </div>

      <div className="mt-4">
        {profile?.affiliate_status === 'approved' ? (
          <div className="bg-white border border-border rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-medium text-ink">Affiliate commissions</div>
              <span className="text-[10px] font-mono bg-green-50 text-green-600 px-2 py-0.5 rounded-full">
                {Math.round(Number(profile.affiliate_commission_rate ?? 0.3) * 100)}% intro · {Math.round(Number(profile.affiliate_commission_rate_lifetime ?? 0.15) * 100)}% lifetime
              </span>
            </div>
            {commissions && commissions.length > 0 ? (
              <div className="flex flex-col gap-2">
                {commissions.map(c => (
                  <div key={c.id} className="flex items-center justify-between text-xs border-b border-border last:border-0 pb-2 last:pb-0">
                    <span className="text-muted">
                      {new Date(c.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                      {' · '}${Number(c.gross_amount_usd).toFixed(2)} order at {Math.round(Number(c.commission_rate) * 100)}%
                    </span>
                    <span className={`font-mono ${c.status === 'paid' ? 'text-green-600' : 'text-ink'}`}>
                      ${Number(c.commission_amount_usd).toFixed(2)} {c.status === 'paid' ? '· paid' : '· pending'}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-muted">No commissions yet — they'll show up here as your referrals order.</div>
            )}
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
