import { createClient, createAdminClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { formatGb } from '@/lib/format'

export default async function EarningsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  // Totals are computed in SQL (reseller_summary) — summing a fetched list
  // silently capped at 1000 rows. This page also used to count TRANSFERS as
  // "active clients" and showed a "pending payment" tile that nothing could
  // ever populate (every transfer is inserted 'active').
  const admin = await createAdminClient()
  const [{ data: bw }, { data: summaryRows }, { data: recent }, { data: openInvites }] = await Promise.all([
    supabase.from('bandwidth_accounts').select('available_gb, total_gb, allocated_gb').eq('user_id', user.id).maybeSingle(),
    admin.rpc('reseller_summary', { p_reseller_id: user.id }),
    admin
      .from('reseller_transfers')
      .select('id, created_at, gb_amount, reclaimed_gb, status, note, recipient:recipient_id(email, is_deleted)')
      .eq('reseller_id', user.id)
      .order('created_at', { ascending: false })
      .limit(10),
    // Stock reserved for invitations nobody has claimed yet: it is out of "available" but not
    // yet with a client, so without this line the tiles do not add up.
    admin.from('reseller_pending_transfers').select('gb_amount').eq('reseller_id', user.id).eq('status', 'pending').limit(1000),
  ])
  const s = (summaryRows as any[])?.[0] ?? {}
  const gross = Number(s.total_allocated_gb ?? 0)
  const reclaimed = Number(s.total_reclaimed_gb ?? 0)
  const net = gross - reclaimed
  const used = Number(s.clients_used_gb ?? 0)

  const reserved = (openInvites ?? []).reduce((a: number, r: any) => a + Number(r.gb_amount), 0)
  const tiles: [string, string, string][] = [
    ['Stock available', `${formatGb(bw?.available_gb)} GB`, 'text-accent'],
    ['Net allocated to clients', `${formatGb(net)} GB`, 'text-ink'],
    ['Clients', String(s.client_count ?? 0), 'text-accent2'],
    ['Consumed by clients', `${formatGb(used)} GB`, 'text-ink'],
    ...(reserved > 0 ? [['Reserved in invitations', `${formatGb(reserved)} GB`, 'text-ink'] as [string, string, string]] : []),
  ]

  return (
    <div className="max-w-4xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">Stock & Activity</h1>
        <p className="text-muted text-sm mt-1">
          Your bandwidth stock and what your clients have done with it. GlobProxy doesn&apos;t see what you charge your
          clients, so revenue and margin aren&apos;t tracked here — use the CSV export on Transfers for your own books.
        </p>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {tiles.map(([l, v, c]) => (
          <div key={l} className="bg-white border border-border rounded-xl p-5">
            <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-2">{l}</div>
            <div className={`font-display text-3xl font-bold ${c}`}>{v}</div>
          </div>
        ))}
      </div>
      <div className="text-xs font-mono text-muted mb-4">
        {formatGb(gross)} GB sent in {s.transfer_count ?? 0} transfers{reclaimed > 0 ? ` · ${formatGb(reclaimed)} GB reclaimed` : ''}
      </div>
      <div className="bg-white border border-border rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="font-display font-bold text-base text-ink">Recent transfers</h2>
          <Link href="/reseller/transfers" className="text-xs font-mono text-accent hover:underline">View all →</Link>
        </div>
        {recent && recent.length > 0 ? (
          <table className="w-full">
            <thead><tr className="border-b border-border bg-surface">{['Date', 'Client', 'GB', 'Status'].map(h => <th key={h} className="text-left px-6 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>)}</tr></thead>
            <tbody>
              {recent.map((t: any, i: number) => (
                <tr key={t.id} className={`${i < recent.length - 1 ? 'border-b border-border' : ''} hover:bg-surface`}>
                  <td className="px-6 py-4 text-xs font-mono text-muted">{new Date(t.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                  <td className="px-6 py-4 text-sm text-ink">{t.recipient?.is_deleted ? 'Deleted account' : (t.recipient?.email ?? '—')}</td>
                  <td className="px-6 py-4 font-mono text-sm font-medium text-ink">{formatGb(Number(t.gb_amount))} GB</td>
                  <td className="px-6 py-4"><span className={`text-[10px] font-mono px-2.5 py-1 rounded-full ${t.status === 'active' ? 'bg-accent2-light text-accent2' : t.status === 'reclaimed' ? 'bg-zinc-100 text-zinc-500' : 'bg-yellow-50 text-yellow-600'}`}>{t.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-center py-14"><p className="text-muted text-sm font-light">No transfers yet.</p></div>
        )}
      </div>
    </div>
  )
}
