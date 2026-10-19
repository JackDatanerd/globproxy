import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Suspense } from 'react'
import PaymentVerifier from '@/components/PaymentVerifier'
import ReferralLinkCard from '@/components/dashboard/ReferralLinkCard'
import { formatGb, formatPct, formatUsd } from '@/lib/format'
import { getProxyPort } from '@/lib/proxyEndpoint'
import { REFERRAL_GB_BONUS, REFERRAL_MIN_ORDER_USD } from '@/lib/referrals'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const [bwRes, credsRes, orderRes, activeRes, profileRes] = await Promise.all([
    supabase.from('bandwidth_accounts').select('total_gb, used_gb, available_gb').eq('user_id', user.id).maybeSingle(),
    supabase.from('proxy_credentials').select('id, label, host, port, protocol, session_type, country, status, activated_at').eq('user_id', user.id).order('created_at', { ascending: false }).limit(5),
    supabase.from('orders').select('id, gb_amount, amount_usd, refunded_usd, payment_status').eq('user_id', user.id).order('created_at', { ascending: false }).limit(4),
    // A real count: "Active proxies" used to be computed from the 5 rows
    // fetched for the list below, so it could never read above 5.
    supabase.from('proxy_credentials').select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('status', 'active'),
    supabase.from('profiles').select('full_name, referral_code, affiliate_status').eq('id', user.id).maybeSingle(),
  ])
  const bw = bwRes.data, creds = credsRes.data, orders = orderRes.data, profile = profileRes.data
  const loadFailed = !!(bwRes.error || credsRes.error || orderRes.error || activeRes.error)

  // "Bandwidth left" is what the customer still owns: purchased minus
  // consumed. It used to show available_gb (purchased minus *allocated*),
  // which dropped the moment a session was created even though not a byte had
  // been used — and contradicted the "used" bar printed right under it.
  // available_gb is still shown, as "unallocated": what can go into a new session.
  const unallocated = bw?.available_gb ?? 0
  const used = bw?.used_gb ?? 0
  const total = bw?.total_gb ?? 0
  const left = Math.max(0, total - used)
  const pct = total > 0 ? (used / total) * 100 : 0
  const firstName = profile?.full_name?.trim().split(/\s+/)[0] || 'there'
  const activeCount = activeRes.count ?? 0

  return (
    <div className="max-w-5xl">
      <Suspense fallback={null}>
        <PaymentVerifier />
      </Suspense>

      {loadFailed && (
        <div className="mb-4 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
          Some of your dashboard data couldn&apos;t be loaded, so the numbers below may be incomplete. Refresh to try again.
        </div>
      )}

      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="font-display font-bold text-2xl text-ink">Good day, {firstName} 👋</h1>
          <p className="text-muted text-sm mt-0.5">Your proxy activity at a glance</p>
        </div>
        <Link href="/dashboard/buy" className="bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-medium shadow-[0_2px_8px_rgba(0,87,255,.2)] hover:-translate-y-0.5 transition-all">+ Buy bandwidth</Link>
      </div>

      {/* Hero: one balance card carries what used to be 2 stat tiles + a
          separate full-width bar — this is the number people come here to
          check and the action they take from it, so it gets its own weight
          instead of competing with three other equally-sized tiles. */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-4 mb-4">
        <div className="relative bg-ink rounded-2xl p-6 sm:p-7 text-white overflow-hidden flex flex-col justify-between">
          <div className="absolute -top-24 -right-16 w-64 h-64 rounded-full bg-accent2/[.16] blur-2xl pointer-events-none" />
          <div className="relative flex items-start justify-between">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest text-white/40">Bandwidth left</div>
              <div className="font-display font-bold text-[40px] sm:text-[44px] leading-tight tracking-tight mt-1">
                {formatGb(left)}<span className="text-lg sm:text-xl font-medium text-white/50 ml-1.5">GB</span>
              </div>
              <div className="text-xs text-white/55 mt-0.5">of {formatGb(total)} GB purchased · {formatGb(unallocated)} GB not yet assigned to a session</div>
            </div>
            <div className="text-[10px] font-mono text-accent2 bg-accent2/[.14] px-2.5 py-1 rounded-full flex-shrink-0">Never expires</div>
          </div>
          {total > 0 && (
            <div className="relative mt-5">
              <div className="h-1.5 bg-white/[.12] rounded-full overflow-hidden">
                <div className="h-full rounded-full bg-gradient-to-r from-accent2 to-teal-300" style={{ width: `${Math.min(pct, 100)}%` }} />
              </div>
              <div className="flex justify-between text-[10.5px] font-mono text-white/40 mt-1.5">
                <span>{formatGb(used)} GB used</span>
                <span>{formatPct(used, total)}% used</span>
              </div>
            </div>
          )}
          <Link href="/dashboard/buy" className="relative mt-4 inline-flex items-center gap-1.5 self-start bg-white/10 hover:bg-white/[.18] text-white px-4 py-2 rounded-lg text-xs font-medium transition-colors w-fit">
            Buy more bandwidth →
          </Link>
        </div>

        <div className="grid grid-rows-2 gap-3">
          <div className="bg-white border border-border rounded-2xl px-5 py-4 flex items-center justify-between">
            <div>
              <div className="text-[9.5px] font-mono uppercase tracking-widest text-muted mb-1">Active proxies</div>
              <div className="font-display font-bold text-[22px] text-accent2">{activeCount}</div>
            </div>
            <div className="w-1.5 h-1.5 rounded-full bg-accent2" />
          </div>
          <div className="bg-white border border-border rounded-2xl px-5 py-4 flex items-center">
            <div>
              <div className="text-[9.5px] font-mono uppercase tracking-widest text-muted mb-1">Free to assign</div>
              <div className="font-display font-bold text-[22px] text-ink">{formatGb(unallocated)} <span className="text-[13px] font-mono text-muted font-normal">GB</span></div>
            </div>
          </div>
        </div>
      </div>

      {profile?.referral_code && (
        <div className="mb-4">
          <ReferralLinkCard code={profile.referral_code} baseUrl={process.env.NEXT_PUBLIC_APP_URL ?? 'https://globproxy.com'}
            isAffiliate={profile.affiliate_status === 'approved'} bonusGb={REFERRAL_GB_BONUS} minOrderUsd={REFERRAL_MIN_ORDER_USD} />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1.15fr_1fr] gap-4">
        {/* Sessions — reuses the same colored-rail status language as the
            /proxies page instead of a plain dot + text, so status reads
            the same way everywhere in the app. */}
        <div className="bg-white border border-border rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between px-5 pt-4.5 pb-3">
            <h2 className="font-display font-semibold text-[15.5px] text-ink">Proxy Sessions</h2>
            <Link href="/dashboard/proxies" className="text-[11px] font-mono text-accent hover:underline">Manage all →</Link>
          </div>
          {creds && creds.length > 0 ? (
            <div className="px-3 pb-3">
              {creds.map(c => {
                const isWarming = c.activated_at && (Date.now() - new Date(c.activated_at).getTime()) < 10 * 60 * 1000
                const rail = c.status === 'pending' ? 'bg-amber-500' : c.status !== 'active' ? 'bg-border' : isWarming ? 'bg-accent' : 'bg-accent2'
                return (
                  <div key={c.id} className="relative flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-surface transition-colors">
                    <div className={`absolute left-0 top-2 bottom-2 w-[3px] rounded-full ${rail}`} />
                    <div className="flex-1 min-w-0 ml-2">
                      <div className="text-[13px] font-medium text-ink truncate">{c.label || 'Untitled session'}</div>
                      <div className="text-[10.5px] font-mono text-muted mt-0.5">{c.host || 'proxy.globproxy.com'}:{c.port || getProxyPort(c.protocol, c.session_type)}</div>
                    </div>
                    {c.country && <span className="text-[9.5px] font-mono bg-accent-light text-accent px-2 py-0.5 rounded-full flex-shrink-0">{c.country}</span>}
                    <div className={`flex items-center gap-1.5 text-[10.5px] font-mono flex-shrink-0 ${c.status === 'active' ? 'text-accent2' : 'text-muted'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${c.status === 'active' ? 'bg-accent2' : 'bg-muted'}`} />
                      {isWarming ? 'warming up' : c.status}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="text-center py-10 px-5">
              <p className="text-muted text-sm font-light">No proxies yet.</p>
              <Link href="/dashboard/buy" className="text-accent text-sm hover:underline mt-1 block">Buy bandwidth to get started →</Link>
            </div>
          )}
        </div>

        {/* Recent orders — proper paid/pending/failed pills instead of one
            badge whose color and text both do the same job. */}
        <div className="bg-white border border-border rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between px-5 pt-4.5 pb-3">
            <h2 className="font-display font-semibold text-[15.5px] text-ink">Recent Orders</h2>
            <Link href="/dashboard/billing" className="text-[11px] font-mono text-accent hover:underline">View all →</Link>
          </div>
          {orders && orders.length > 0 ? (
            <div className="px-5 pb-4">
              {orders.map((o, i) => (
                <div key={o.id} className={`flex items-center justify-between py-3 ${i < orders.length - 1 ? 'border-b border-border' : ''}`}>
                  <div>
                    <div className="text-[13.5px] font-semibold text-ink">{formatGb(o.gb_amount)} GB</div>
                    <div className="text-[10.5px] font-mono text-muted mt-0.5">Paystack</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs font-mono text-ink2">{formatUsd(o.amount_usd)}</div>
                    <span className={`text-[9px] font-mono px-2 py-0.5 rounded-full uppercase tracking-wide inline-block mt-1 ${
                      o.payment_status === 'paid' ? 'bg-accent2-light text-accent2'
                      : o.payment_status === 'pending' ? 'bg-amber-50 text-amber-600'
                      : o.payment_status === 'cancelled' || o.payment_status === 'refunded' ? 'bg-surface text-muted border border-border'
                      : 'bg-red-50 text-red-500'
                    }`}>{o.payment_status}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-10 px-5">
              <p className="text-muted text-sm font-light">No orders yet.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
