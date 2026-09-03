import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Suspense } from 'react'
import PaymentVerifier from '@/components/PaymentVerifier'
import ReferralLinkCard from '@/components/dashboard/ReferralLinkCard'
import { formatGb, formatPct } from '@/lib/format'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const [{ data: bw }, { data: creds }, { data: orders }] = await Promise.all([
    supabase.from('bandwidth_accounts').select('*').eq('user_id', user.id).single(),
    supabase.from('proxy_credentials').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(5),
    supabase.from('orders').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(4),
  ])

  const { data: profile } = await supabase.from('profiles').select('full_name, referral_code').eq('id', user.id).single()
  const available = bw?.available_gb ?? 0
  const used = bw?.used_gb ?? 0
  const total = bw?.total_gb ?? 0
  const pct = total > 0 ? (used / total) * 100 : 0
  const firstName = profile?.full_name?.split(' ')[0] ?? 'there'
  const activeCount = creds?.filter(c => c.status === 'active').length ?? 0

  return (
    <div className="max-w-5xl">
      <Suspense fallback={null}>
        <PaymentVerifier />
      </Suspense>

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
                {formatGb(available)}<span className="text-lg sm:text-xl font-medium text-white/50 ml-1.5">GB</span>
              </div>
              <div className="text-xs text-white/55 mt-0.5">of {formatGb(total)} GB purchased</div>
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
              <div className="text-[9.5px] font-mono uppercase tracking-widest text-muted mb-1">Total purchased, all time</div>
              <div className="font-display font-bold text-[22px] text-ink">{formatGb(total)} <span className="text-[13px] font-mono text-muted font-normal">GB</span></div>
            </div>
          </div>
        </div>
      </div>

      {profile?.referral_code && (
        <div className="mb-4">
          <ReferralLinkCard code={profile.referral_code} />
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
                const rail = c.status !== 'active' ? 'bg-amber-500' : isWarming ? 'bg-accent' : 'bg-accent2'
                return (
                  <div key={c.id} className="relative flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-surface transition-colors">
                    <div className={`absolute left-0 top-2 bottom-2 w-[3px] rounded-full ${rail}`} />
                    <div className="flex-1 min-w-0 ml-2">
                      <div className="text-[13px] font-medium text-ink truncate">{c.label || 'Untitled session'}</div>
                      <div className="text-[10.5px] font-mono text-muted mt-0.5">{c.host || 'proxy.globproxy.com'}:{c.port ?? ''}</div>
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
                    <div className="text-[13.5px] font-semibold text-ink">{o.gb_amount} GB</div>
                    <div className="text-[10.5px] font-mono text-muted mt-0.5">Paystack</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs font-mono text-ink2">${o.amount_usd}</div>
                    <span className={`text-[9px] font-mono px-2 py-0.5 rounded-full uppercase tracking-wide inline-block mt-1 ${
                      o.payment_status === 'paid' ? 'bg-accent2-light text-accent2'
                      : o.payment_status === 'pending' ? 'bg-amber-50 text-amber-600'
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
