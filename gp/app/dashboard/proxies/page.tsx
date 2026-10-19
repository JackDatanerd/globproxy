import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import ProxyList from '@/components/dashboard/ProxyList'
import { formatGb, formatPct } from '@/lib/format'

export default async function ProxiesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const [{ data: creds, error: credsError }, { data: bw }] = await Promise.all([
    supabase.from('proxy_credentials')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false }),
    supabase.from('bandwidth_accounts')
      .select('total_gb, used_gb, available_gb')
      .eq('user_id', user.id)
      .single(),
  ])

  // A failed query used to fall through to the "No sessions yet" empty state,
  // inviting the customer to create a duplicate of a session that exists.
  if (credsError) {
    return (
      <div className="max-w-4xl">
        <h1 className="font-display font-bold text-2xl text-ink mb-4">My Proxies</h1>
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-5 py-4 text-sm">
          We couldn&apos;t load your sessions right now. Your proxies are unaffected — refresh the page to try again.
        </div>
      </div>
    )
  }

  // Never hand the browser the raw rows: their column names (and the
  // supplier's internal sub-user id) would show in the page payload. Expose
  // only neutral names.
  const safeCreds = (creds ?? []).map((row: Record<string, any>) => {
    const { geonode_username, geonode_password, geonode_sub_user_id: _drop, ...rest } = row
    void _drop
    return { ...rest, username: geonode_username ?? null, password: geonode_password ?? null }
  })

  const total     = bw?.total_gb     ?? 0
  const used      = bw?.used_gb      ?? 0
  const available = bw?.available_gb ?? 0
  const pct       = total > 0 ? (used / total) * 100 : 0

  return (
    <div className="max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="font-display font-bold text-2xl text-ink">My Proxies</h1>
          <p className="text-muted text-sm mt-1">
            {creds?.length ?? 0} session{creds?.length === 1 ? '' : 's'} · manage credentials, endpoints, and sticky sessions
          </p>
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

      {/* Bandwidth strip — condensed to one row so the list starts higher on
          the page; the full breakdown/CTA lives on the Overview page. */}
      {total > 0 && (
        <div className="bg-white border border-border rounded-xl px-5 py-4 mb-5 flex items-center gap-7 flex-wrap">
          {[
            ['Total', `${formatGb(total)} GB`, 'text-ink'],
            ['Used', `${formatGb(used)} GB`, 'text-amber-500'],
            ['Available', `${formatGb(available)} GB`, 'text-accent2'],
          ].map(([l, v, c]) => (
            <div key={l as string} className="flex-shrink-0">
              <div className="text-[9px] font-mono text-muted uppercase tracking-wider mb-0.5">{l}</div>
              <div className={`font-display font-bold text-base tracking-tight ${c}`}>{v}</div>
            </div>
          ))}
          <div className="flex-1 min-w-[160px]">
            <div className="bg-surface rounded-full h-[7px] overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-700 ${pct > 80 ? 'bg-red-400' : pct > 50 ? 'bg-amber-400' : 'bg-gradient-to-r from-accent to-sky-400'}`}
                style={{ width: `${Math.min(pct, 100)}%` }}
              />
            </div>
            <div className="flex justify-between text-[10.5px] font-mono text-muted mt-1">
              <span>{formatPct(used, total)}% used</span>
              <span>{formatGb(available)} GB free to allocate</span>
            </div>
          </div>
          <div className="text-[10.5px] font-mono text-accent2 bg-accent2-light px-2.5 py-1 rounded-full flex-shrink-0">Never expires</div>
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

      {/* Proxy list */}
      {creds && creds.length > 0 ? (
        <ProxyList creds={safeCreds as typeof creds} availableGb={available} />
      ) : total > 0 ? (
        <div className="bg-white border border-border rounded-xl p-12 text-center">
          <div className="text-3xl mb-3">⬡</div>
          <h2 className="font-display font-bold text-lg text-ink mb-2">No sessions yet</h2>
          <p className="text-muted text-sm font-light mb-5 max-w-xs mx-auto">
            You have {formatGb(available)} GB ready to use. Create your first proxy session.
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
