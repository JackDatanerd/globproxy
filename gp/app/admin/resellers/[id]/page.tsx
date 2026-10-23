import { createAdminClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import AdminCancelInvitation from '@/components/admin/AdminCancelInvitation'
import { formatGb } from '@/lib/format'
import { isUuid } from '@/lib/adminAuth'

// One reseller's ledger: stock, what they sent and reclaimed, open invitations
// (cancellable), and their latest transfers. Support used to have nothing between
// the resellers list and the raw tables.
export default async function AdminResellerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) notFound()
  const supabase = await createAdminClient()
  const { data: p } = await supabase.from('profiles')
    .select('id, full_name, email, role, is_suspended, is_deleted, created_at, reseller_low_stock_gb').eq('id', id).maybeSingle()
  if (!p || p.role !== 'reseller') notFound()

  const [{ data: bw }, { data: summaryRows }, { data: invites }, { data: transfers }] = await Promise.all([
    supabase.from('bandwidth_accounts').select('total_gb, used_gb, allocated_gb, available_gb').eq('user_id', id).maybeSingle(),
    supabase.rpc('reseller_summary', { p_reseller_id: id }),
    supabase.from('reseller_pending_transfers')
      .select('id, recipient_email, gb_amount, created_at, expires_at').eq('reseller_id', id).eq('status', 'pending')
      .order('created_at', { ascending: false }).limit(100),
    supabase.from('reseller_transfers')
      .select('id, created_at, gb_amount, reclaimed_gb, status, recipient:recipient_id(email, is_deleted)')
      .eq('reseller_id', id).order('created_at', { ascending: false }).limit(25),
  ])
  const s = (summaryRows as any[])?.[0] ?? {}
  const reserved = (invites ?? []).reduce((a: number, r: any) => a + Number(r.gb_amount), 0)
  const fmt = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  const tiles: [string, string][] = [
    ['Available', `${formatGb(bw?.available_gb)} GB`],
    ['Total stock', `${formatGb(bw?.total_gb)} GB`],
    ['Sent to clients', `${formatGb(Number(s.total_allocated_gb ?? 0))} GB`],
    ['Reclaimed', `${formatGb(Number(s.total_reclaimed_gb ?? 0))} GB`],
    ['Clients', String(s.client_count ?? 0)],
    ['In open invitations', `${formatGb(reserved)} GB`],
  ]

  return (
    <div className="max-w-5xl">
      <Link href="/admin/resellers" className="text-xs font-mono text-muted hover:text-ink">← Resellers</Link>
      <div className="mt-3 mb-6">
        <h1 className="font-display font-bold text-2xl text-ink">
          {p.full_name || '—'}
          {p.is_suspended && <span className="ml-2 text-[10px] font-mono bg-red-50 text-red-500 px-2 py-0.5 rounded-full align-middle">Suspended</span>}
          {p.is_deleted && <span className="ml-2 text-[10px] font-mono bg-zinc-100 text-zinc-500 px-2 py-0.5 rounded-full align-middle">Deleted</span>}
        </h1>
        <p className="text-muted text-sm mt-1 font-mono">{p.email} · joined {fmt(p.created_at)}{p.reseller_low_stock_gb ? ` · low-stock alert at ${formatGb(Number(p.reseller_low_stock_gb))} GB` : ''}</p>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        {tiles.map(([l, v]) => (
          <div key={l} className="bg-white border border-border rounded-xl p-4">
            <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-1">{l}</div>
            <div className="font-display text-2xl font-bold text-ink">{v}</div>
          </div>
        ))}
      </div>

      <div className="bg-white border border-border rounded-xl overflow-hidden mb-8">
        <div className="px-6 py-4 border-b border-border"><h2 className="font-display font-bold text-base text-ink">Open invitations ({invites?.length ?? 0})</h2></div>
        {invites && invites.length > 0 ? (
          <table className="w-full">
            <thead><tr className="border-b border-border bg-surface">{['Address', 'GB', 'Sent', 'Expires', ''].map(h => <th key={h} className="text-left px-6 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>)}</tr></thead>
            <tbody>
              {invites.map((r: any) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="px-6 py-3 text-xs font-mono text-ink">{r.recipient_email}</td>
                  <td className="px-6 py-3 text-xs font-mono">{formatGb(Number(r.gb_amount))} GB</td>
                  <td className="px-6 py-3 text-xs font-mono text-muted">{fmt(r.created_at)}</td>
                  <td className="px-6 py-3 text-xs font-mono text-muted">{fmt(r.expires_at)}</td>
                  <td className="px-6 py-3 text-right"><AdminCancelInvitation pendingId={r.id} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="text-center py-8 text-muted text-sm font-light">No open invitations.</div>}
      </div>

      <div className="bg-white border border-border rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-border"><h2 className="font-display font-bold text-base text-ink">Latest transfers</h2></div>
        {transfers && transfers.length > 0 ? (
          <table className="w-full">
            <thead><tr className="border-b border-border bg-surface">{['Date', 'Client', 'GB', 'Reclaimed', 'Status'].map(h => <th key={h} className="text-left px-6 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>)}</tr></thead>
            <tbody>
              {transfers.map((t: any) => (
                <tr key={t.id} className="border-b border-border last:border-0">
                  <td className="px-6 py-3 text-xs font-mono text-muted">{fmt(t.created_at)}</td>
                  <td className="px-6 py-3 text-xs text-ink">{t.recipient?.is_deleted ? 'Deleted account' : (t.recipient?.email ?? '—')}</td>
                  <td className="px-6 py-3 text-xs font-mono">{formatGb(Number(t.gb_amount))} GB</td>
                  <td className="px-6 py-3 text-xs font-mono text-muted">{Number(t.reclaimed_gb ?? 0) > 0 ? `${formatGb(Number(t.reclaimed_gb))} GB` : '—'}</td>
                  <td className="px-6 py-3 text-xs font-mono text-muted">{t.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="text-center py-8 text-muted text-sm font-light">No transfers yet.</div>}
      </div>
    </div>
  )
}
