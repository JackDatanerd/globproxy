import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { formatGb, formatPct } from '@/lib/format'

export default async function UsagePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const [{ data: bw }, { data: creds }] = await Promise.all([
    supabase.from('bandwidth_accounts').select('*').eq('user_id', user.id).single(),
    supabase.from('proxy_credentials').select('*').eq('user_id', user.id).eq('status','active').order('gb_used',{ascending:false}),
  ])
  const total = bw?.total_gb ?? 0
  const used = bw?.used_gb ?? 0
  const available = bw?.available_gb ?? 0

  return (
    <div className="max-w-4xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">Usage</h1>
        <p className="text-muted text-sm mt-1">Bandwidth consumption across all your sessions</p>
      </div>
      <div className="bg-white border border-border rounded-xl p-6 mb-6">
        <h2 className="font-display font-bold text-base text-ink mb-5">Overall bandwidth</h2>
        <div className="grid grid-cols-3 gap-4 mb-5">
          {[['Total purchased',`${formatGb(total)} GB`,'text-ink'],['Used',`${formatGb(used)} GB`,'text-accent'],['Remaining',`${formatGb(available)} GB`,'text-accent2']].map(([l,v,c])=>(
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
      <div className="bg-white border border-border rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-border"><h2 className="font-display font-bold text-base text-ink">Per-session breakdown</h2></div>
        {creds && creds.length > 0 ? (
          <div className="divide-y divide-border">
            {creds.map(c => {
              const pct = c.gb_allocated > 0 ? (c.gb_used/c.gb_allocated)*100 : 0
              return (
                <div key={c.id} className="px-6 py-5">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-3">
                      <span className="font-medium text-sm text-ink">{c.label||'Unnamed'}</span>
                      {c.country && <span className="text-[11px] font-mono bg-accent-light text-accent px-2 py-0.5 rounded">{c.country}</span>}
                    </div>
                    <span className="text-xs font-mono text-muted">{formatGb(c.gb_used)} / {formatGb(c.gb_allocated)} GB</span>
                  </div>
                  <div className="bg-surface rounded-full h-2 overflow-hidden">
                    <div className={`h-full rounded-full ${pct>80?'bg-red-400':pct>50?'bg-yellow-400':'bg-accent2'}`} style={{width:`${Math.min(pct,100)}%`}} />
                  </div>
                  <div className="flex justify-between mt-1 text-xs font-mono text-muted">
                    <span>{formatPct(c.gb_used, c.gb_allocated)}% used</span><span>{formatGb(Math.max(0,c.gb_allocated-c.gb_used))} GB left</span>
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
