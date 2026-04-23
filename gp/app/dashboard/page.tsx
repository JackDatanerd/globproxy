import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const [{ data: bw }, { data: creds }, { data: orders }] = await Promise.all([
    supabase.from('bandwidth_accounts').select('*').eq('user_id', user!.id).single(),
    supabase.from('proxy_credentials').select('*').eq('user_id', user!.id).order('created_at', { ascending: false }).limit(5),
    supabase.from('orders').select('*').eq('user_id', user!.id).order('created_at', { ascending: false }).limit(5),
  ])

  const { data: profile } = await supabase.from('profiles').select('full_name').eq('id', user!.id).single()
  const available = bw?.available_gb ?? 0
  const used = bw?.used_gb ?? 0
  const total = bw?.total_gb ?? 0
  const pct = total > 0 ? (used / total) * 100 : 0
  const firstName = profile?.full_name?.split(' ')[0] ?? 'there'

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="font-display font-bold text-2xl text-ink">Good day, {firstName} 👋</h1>
          <p className="text-muted text-sm mt-0.5">Your proxy activity at a glance</p>
        </div>
        <Link href="/dashboard/buy" className="bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-medium shadow-[0_2px_8px_rgba(0,87,255,.2)] hover:-translate-y-0.5 transition-all">+ Buy bandwidth</Link>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[
          { label:'Bandwidth left', value:`${available.toFixed(1)} GB`, sub:'Never expires', color:'text-accent' },
          { label:'Total purchased', value:`${total.toFixed(1)} GB`, sub:'All time', color:'text-ink' },
          { label:'Used', value:`${used.toFixed(1)} GB`, sub:'All time', color:'text-ink' },
          { label:'Active proxies', value:String(creds?.filter(c=>c.status==='active').length??0), sub:'Running now', color:'text-accent2' },
        ].map(m=>(
          <div key={m.label} className="bg-white border border-border rounded-xl p-5">
            <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-2">{m.label}</div>
            <div className={`font-display text-3xl font-bold tracking-tight ${m.color}`}>{m.value}</div>
            <div className="text-xs text-muted mt-1">{m.sub}</div>
          </div>
        ))}
      </div>

      {/* Bandwidth bar */}
      {total > 0 && (
        <div className="bg-white border border-border rounded-xl p-5 mb-6">
          <div className="flex justify-between text-sm mb-3">
            <span className="font-medium text-ink">Bandwidth usage</span>
            <span className="font-mono text-xs text-muted">{used.toFixed(1)} / {total.toFixed(1)} GB</span>
          </div>
          <div className="bg-surface rounded-full h-2.5 overflow-hidden">
            <div className="h-full rounded-full bg-gradient-to-r from-accent to-sky-400 transition-all duration-700" style={{ width:`${Math.min(pct,100)}%` }} />
          </div>
          <div className="flex justify-between text-xs font-mono text-muted mt-1.5">
            <span>{pct.toFixed(1)}% used</span><span>{available.toFixed(1)} GB remaining · Never expires</span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Sessions */}
        <div className="lg:col-span-3 bg-white border border-border rounded-xl p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-display font-bold text-base text-ink">Proxy Sessions</h2>
            <Link href="/dashboard/proxies" className="text-xs font-mono text-accent hover:underline">Manage all →</Link>
          </div>
          {creds && creds.length > 0 ? creds.map((c,i) => (
            <div key={c.id} className={`flex items-center justify-between py-3 ${i<creds.length-1?'border-b border-border':''}`}>
              <div>
                <div className="text-sm font-medium text-ink">{c.label||`Session #${i+1}`}</div>
                <div className="text-xs font-mono text-muted mt-0.5">{c.host}:{c.port}</div>
              </div>
              <div className="flex items-center gap-3">
                {c.country && <span className="bg-accent-light text-accent text-[11px] font-mono px-2 py-0.5 rounded">{c.country}</span>}
                <div className={`flex items-center gap-1.5 text-xs ${c.status==='active'?'text-accent2':'text-muted'}`}>
                  <div className={`w-1.5 h-1.5 rounded-full ${c.status==='active'?'bg-accent2':'bg-muted'}`} />
                  {c.status}
                </div>
              </div>
            </div>
          )) : (
            <div className="text-center py-10">
              <p className="text-muted text-sm font-light">No proxies yet.</p>
              <Link href="/dashboard/buy" className="text-accent text-sm hover:underline mt-1 block">Buy bandwidth to get started →</Link>
            </div>
          )}
        </div>

        {/* Recent orders */}
        <div className="lg:col-span-2 bg-white border border-border rounded-xl p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-display font-bold text-base text-ink">Recent Orders</h2>
            <Link href="/dashboard/billing" className="text-xs font-mono text-accent hover:underline">View all →</Link>
          </div>
          {orders && orders.length > 0 ? orders.map((o,i) => (
            <div key={o.id} className={`py-3 ${i<orders.length-1?'border-b border-border':''}`}>
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium text-ink">{o.gb_amount} GB</span>
                <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full ${o.payment_status==='paid'?'bg-accent2-light text-accent2':o.payment_status==='pending'?'bg-yellow-50 text-yellow-600':'bg-red-50 text-red-500'}`}>{o.payment_status}</span>
              </div>
              <div className="flex justify-between mt-0.5">
                <span className="text-xs font-mono text-muted">Paystack</span>
                <span className="text-xs font-mono text-ink2">${o.amount_usd}</span>
              </div>
            </div>
          )) : (
            <div className="text-center py-10">
              <p className="text-muted text-sm font-light">No orders yet.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
