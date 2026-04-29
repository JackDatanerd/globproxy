import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import ProxyCard from '@/components/dashboard/ProxyCard'

export default async function ProxiesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const [{ data: creds }, { data: bw }] = await Promise.all([
    supabase
      .from('proxy_credentials')
      .select('*')
      .eq('user_id', user!.id)
      .order('created_at', { ascending: false }),
    supabase
      .from('bandwidth_accounts')
      .select('available_gb, used_gb, total_gb')
      .eq('user_id', user!.id)
      .single(),
  ])

  const available = bw?.available_gb ?? 0
  const used = bw?.used_gb ?? 0
  const total = bw?.total_gb ?? 0
  const pct = total > 0 ? (used / total) * 100 : 0

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="font-display font-bold text-2xl text-ink">My Proxies</h1>
          <p className="text-muted text-sm mt-1">Manage your proxy sessions and credentials</p>
        </div>
        <Link
          href="/dashboard/proxies/new"
          className="bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:-translate-y-0.5 transition-all shadow-[0_2px_8px_rgba(0,87,255,.2)]"
        >
          + New session
        </Link>
      </div>

      {/* Bandwidth bar */}
      {total > 0 && (
        <div className="bg-white border border-border rounded-xl p-5 mb-6">
          <div className="flex justify-between text-sm mb-3">
            <span className="font-medium text-ink">Bandwidth</span>
            <span className="font-mono text-xs text-muted">{used.toFixed(1)} / {total.toFixed(1)} GB used</span>
          </div>
          <div className="bg-surface rounded-full h-2 overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-accent to-sky-400 transition-all duration-700"
              style={{ width: `${Math.min(pct, 100)}%` }}
            />
          </div>
          <div className="flex justify-between text-xs font-mono text-muted mt-1.5">
            <span>{pct.toFixed(1)}% used</span>
            <span>{available.toFixed(1)} GB remaining · Never expires</span>
          </div>
        </div>
      )}

      {/* Credentials list */}
      {creds && creds.length > 0 ? (
        <div className="flex flex-col gap-3">
          {creds.map(c => (
            <ProxyCard key={c.id} cred={c} />
          ))}
        </div>
      ) : (
        <div className="bg-white border border-border rounded-xl p-16 text-center">
          <h2 className="font-display font-bold text-lg text-ink mb-2">No proxy sessions yet</h2>
          <p className="text-muted text-sm font-light mb-6 max-w-xs mx-auto">
            Buy bandwidth first, then create sessions targeting any country or city worldwide.
          </p>
          <Link
            href="/dashboard/buy"
            className="inline-flex items-center gap-2 bg-accent text-white px-6 py-2.5 rounded-xl text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Buy bandwidth →
          </Link>
        </div>
      )}
    </div>
  )
}
