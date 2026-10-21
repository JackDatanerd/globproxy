import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { formatGb, formatPct } from '@/lib/format'
import UsageHistoryChart from '@/components/dashboard/UsageHistoryChart'

export default async function UsagePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const [bwRes, credsRes] = await Promise.all([
    supabase.from('bandwidth_accounts').select('total_gb, used_gb, available_gb').eq('user_id', user.id).maybeSingle(),
    supabase.from('proxy_credentials').select('id, label, country, gb_used, gb_allocated').eq('user_id', user.id).eq('status','active').order('gb_used',{ascending:false}),
  ])
  const bw = bwRes.data, creds = credsRes.data
  const total = bw?.total_gb ?? 0
  const used = bw?.used_gb ?? 0
  // Remaining = purchased - used (what the customer still owns). This tile
  // used to show available_gb, i.e. purchased - *allocated*, which fell the
  // moment a session was created and so contradicted "Used" right beside it.
  const remaining = Math.max(0, total - used)
  const unallocated = bw?.available_gb ?? 0

  return (
    <div className="max-w-4xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">Usage</h1>
        <p className="text-muted text-sm mt-1">Bandwidth consumption across all your sessions</p>
      </div>
      {(bwRes.error || credsRes.error) && (
        <div className="mb-4 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
          Some usage data couldn&apos;t be loaded, so the figures below may be incomplete. Refresh to try again.
        </div>
      )}
      <div className="bg-white border border-border rounded-xl p-6 mb-6">
        <h2 className="font-display font-bold text-base text-ink mb-5">Overall bandwidth</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
          {[['Total purchased',`${formatGb(total)} GB`,'text-ink'],['Used',`${formatGb(used)} GB`,'text-accent'],['Remaining',`${formatGb(remaining)} GB`,'text-accent2'],['Free to assign',`${formatGb(unallocated)} GB`,'text-ink2']].map(([l,v,c])=>(
            <div key={l} className="bg-surface rounded-xl p-4">
              <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-1">{l}</div>
              <div className={`font-display text-2xl font-bold ${c}`}>{v}</div>
            </div>
          ))}
        </div>
        {total > 0 && (
          <>
            <div className="bg-surface rounded-full h-3 overflow-hidden mb-1.5">
              <div className="h-full rounded-full bg-gradient-to-r from-accent to-sky-400" style={{width:`${Math.min((used/total)*100,100)}%`}} />
            </div>
            <div className="flex justify-between text-xs font-mono text-muted">
              <span>{formatPct(used, total)}% used</span><span>Never expires ✓</span>
            </div>
          </>
        )}
      </div>
      <UsageHistoryChart sessions={(creds ?? []).map(c => ({ id: c.id, label: c.label || c.country || 'Unnamed' }))} />

      <div className="bg-white border border-border rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <h2 className="font-display font-bold text-base text-ink">Per-session breakdown</h2>
          <p className="text-xs text-muted mt-0.5">Active sessions only. Usage from sessions you&apos;ve deleted still counts in the totals above.</p>
        </div>
        {creds && creds.length > 0 ? (
          <div className="divide-y divide-border">
            {creds.map(c => {
              const cUsed = c.gb_used ?? 0
              const pct = c.gb_allocated > 0 ? (cUsed/c.gb_allocated)*100 : 0
              return (
                <div key={c.id} className="px-6 py-5">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-3">
                      <span className="font-medium text-sm text-ink">{c.label||'Unnamed'}</span>
                      {c.country && <span className="text-[11px] font-mono bg-accent-light text-accent px-2 py-0.5 rounded">{c.country}</span>}
                    </div>
                    <span className="text-xs font-mono text-muted">{formatGb(cUsed)} / {formatGb(c.gb_allocated)} GB</span>
                  </div>
                  <div className="bg-surface rounded-full h-2 overflow-hidden">
                    <div className={`h-full rounded-full ${pct>=95?'bg-red-400':pct>=80?'bg-amber-400':'bg-accent2'}`} style={{width:`${Math.min(pct,100)}%`}} />
                  </div>
                  <div className="flex justify-between mt-1 text-xs font-mono text-muted">
                    <span>{formatPct(cUsed, c.gb_allocated)}% used</span><span>{formatGb(Math.max(0,c.gb_allocated-cUsed))} GB left</span>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="text-center py-14">
            <p className="text-muted text-sm font-light">No active sessions.</p>
            <Link href="/dashboard/proxies/new" className="text-accent text-sm hover:underline mt-1 block">Create a session →</Link>
          </div>
        )}
      </div>
    </div>
  )
}
