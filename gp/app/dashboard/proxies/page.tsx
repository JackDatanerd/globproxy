import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import ProxyCard from '@/components/dashboard/ProxyCard'

export default async function ProxiesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const [{ data: creds }, { data: bw }] = await Promise.all([
    supabase.from('proxy_credentials')
      .select('*')
      .eq('user_id', user!.id)
      .order('created_at', { ascending: false }),
    supabase.from('bandwidth_accounts')
      .select('total_gb, used_gb, available_gb')
      .eq('user_id', user!.id)
      .single(),
  ])

  const total     = bw?.total_gb     ?? 0
  const used      = bw?.used_gb      ?? 0
  const available = bw?.available_gb ?? 0
  const pct       = total > 0 ? (used / total) * 100 : 0

  return (
    <div className="max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-display font-bold text-2xl text-ink">My Proxies</h1>
          <p className="text-muted text-sm mt-1">Manage your proxy sessions and credentials</p>
        </div>
        {available > 0 ? (
          <Link href="/dashboard/proxies/new"
            className="bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:-translate-y-0.5 transition-all shadow-[0_2px_8px_rgba(0,87,255,.2)]">
            + New session
          </Link>
        ) : (
          <Link href="/dashboard/buy"
            className="bg-surface border border-border text-muted px-5 py-2.5 rounded-xl text-sm font-medium hover:text-ink transition-colors">
            Buy bandwidth first
          </Link>
        )}
      </div>

      {/* Bandwidth summary bar */}
      {total > 0 && (
        <div className="bg-white border border-border rounded-xl p-5 mb-6">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-medium text-ink">Bandwidth overview</div>
            <div className="text-xs font-mono text-accent2 bg-accent2-light px-2.5 py-1 rounded-full">Never expires</div>
          </div>
          <div className="grid grid-cols-3 gap-4 mb-4">
            {[
              ['Total purchased', `${total.toFixed(2)} GB`, 'text-ink'],
              ['Used / allocated', `${used.toFixed(2)} GB`, 'text-amber-500'],
              ['Available', `${available.toFixed(2)} GB`, 'text-accent2'],
            ].map(([l, v, c]) => (
              <div key={l as string}>
                <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-0.5">{l}</div>
                <div className={`font-display font-bold text-xl tracking-tight ${c}`}>{v}</div>
              </div>
            ))}
          </div>
          <div className="bg-surface rounded-full h-2 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-700 ${pct > 80 ? 'bg-red-400' : pct > 50 ? 'bg-amber-400' : 'bg-gradient-to-r from-accent to-sky-400'}`}
              style={{ width: `${Math.min(pct, 100)}%` }}
            />
          </div>
          <div className="flex justify-between text-[11px] font-mono text-muted mt-1.5">
            <span>{pct.toFixed(1)}% allocated</span>
            <span>{available.toFixed(2)} GB free to allocate</span>
          </div>
        </div>
      )}

      {/* No bandwidth state */}
      {total === 0 && (
        <div className="bg-white border border-border rounded-xl p-12 text-center mb-6">
          <div className="text-3xl mb-3">⬡</div>
          <h2 className="font-display font-bold text-lg text-ink mb-2">No bandwidth yet</h2>
          <p className="text-muted text-sm font-light mb-5 max-w-xs mx-auto">
            Purchase bandwidth to start creating proxy sessions. Your GB never expires.
          </p>
          <Link href="/dashboard/buy"
            className="inline-flex items-center gap-2 bg-accent text-white px-6 py-2.5 rounded-xl text-sm font-medium hover:opacity-90 transition-opacity">
            Buy bandwidth →
          </Link>
        </div>
      )}

      {/* Proxy cards */}
      {creds && creds.length > 0 ? (
        <div className="flex flex-col gap-4">
          {creds.map((cred, i) => (
            <ProxyCard key={cred.id} cred={cred} index={i} />
          ))}
        </div>
      ) : total > 0 ? (
        <div className="bg-white border border-border rounded-xl p-12 text-center">
          <div className="text-3xl mb-3">⬡</div>
          <h2 className="font-display font-bold text-lg text-ink mb-2">No sessions yet</h2>
          <p className="text-muted text-sm font-light mb-5 max-w-xs mx-auto">
            You have {available.toFixed(2)} GB ready to use. Create your first proxy session.
          </p>
          <Link href="/dashboard/proxies/new"
            className="inline-flex items-center gap-2 bg-accent text-white px-6 py-2.5 rounded-xl text-sm font-medium hover:opacity-90 transition-opacity">
            + New session →
          </Link>
        </div>
      ) : null}
    </div>
  )
}
