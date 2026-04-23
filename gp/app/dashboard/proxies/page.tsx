import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'

export default async function ProxiesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const { data: creds } = await supabase.from('proxy_credentials').select('*').eq('user_id', user!.id).order('created_at', { ascending: false })

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="font-display font-bold text-2xl text-ink">My Proxies</h1>
          <p className="text-muted text-sm mt-1">Manage your proxy sessions and credentials</p>
        </div>
        <Link href="/dashboard/proxies/new" className="bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:-translate-y-0.5 transition-all shadow-[0_2px_8px_rgba(0,87,255,.2)]">+ New session</Link>
      </div>
      {creds && creds.length > 0 ? (
        <div className="flex flex-col gap-3">
          {creds.map(c => (
            <div key={c.id} className="bg-white border border-border rounded-xl p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-1">
                    <span className="font-medium text-ink">{c.label || 'Unnamed session'}</span>
                    <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full ${c.status==='active'?'bg-accent2-light text-accent2':c.status==='pending'?'bg-yellow-50 text-yellow-600':'bg-red-50 text-red-400'}`}>{c.status}</span>
                    <span className="text-[10px] font-mono bg-surface text-muted px-2 py-0.5 rounded-full">{c.session_type}</span>
                  </div>
                  {c.country && <div className="text-xs text-muted mb-3">{[c.country,c.state,c.city].filter(Boolean).join(' · ')}</div>}
                  {c.status === 'active' && c.geonode_username ? (
                    <div className="bg-surface rounded-lg p-3 grid grid-cols-2 gap-x-6 gap-y-1.5">
                      {[['Host',c.host],['Port',c.port],['Username',c.geonode_username],['Password','••••••••']].map(([l,v]) => (
                        <div key={l} className="flex gap-2 items-center">
                          <span className="text-[10px] font-mono text-muted w-16 flex-shrink-0">{l}</span>
                          <span className="text-xs font-mono text-ink">{v}</span>
                        </div>
                      ))}
                    </div>
                  ) : c.status === 'pending' ? (
                    <div className="text-xs text-yellow-600 bg-yellow-50 px-3 py-2 rounded-lg font-mono">⏳ Activates upon payment confirmation</div>
                  ) : null}
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-sm font-mono text-ink">{c.gb_allocated} GB</div>
                  <div className="text-xs text-muted">allocated</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-white border border-border rounded-xl p-16 text-center">
          <h2 className="font-display font-bold text-lg text-ink mb-2">No proxy sessions yet</h2>
          <p className="text-muted text-sm font-light mb-6 max-w-xs mx-auto">Buy bandwidth first, then create sessions targeting any country or city.</p>
          <Link href="/dashboard/buy" className="inline-flex items-center gap-2 bg-accent text-white px-6 py-2.5 rounded-xl text-sm font-medium hover:opacity-90 transition-opacity">Buy bandwidth →</Link>
        </div>
      )}
    </div>
  )
}
