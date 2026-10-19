import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/server'
import AdminPager, { parsePage, cleanSearch } from '@/components/admin/AdminPager'
import { formatGb } from '@/lib/format'

const PAGE_SIZE = 50
// 'refund' = any order with money refunded (partial refunds keep status 'paid').
const FILTERS = ['paid', 'pending', 'failed', 'cancelled', 'refunded', 'refund'] as const

export default async function AdminOrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const page = parsePage(sp.page)
  const q = cleanSearch(sp.q)
  const status = typeof sp.status === 'string' && (FILTERS as readonly string[]).includes(sp.status) ? sp.status : ''

  const supabase = await createAdminClient()

  // Headline stats come from admin_order_stats() (migration 0043): a
  // server-side aggregate, NET of refunds, canary excluded — the same maths
  // as the Overview and Sales Cycles pages. This page used to sum gross
  // amounts client-side (ignoring partial refunds) from an unpaginated
  // query that PostgREST silently caps at 1000 rows.
  const statsRes = await supabase.rpc('admin_order_stats')
  const stats = (statsRes.data?.[0] ?? null) as { revenue_usd: number; gb_sold: number; order_count: number } | null

  // Email search resolves to user ids first (orders only store user_id).
  let searchIds: string[] | null = null
  if (q) {
    const { data: matches } = await supabase
      .from('profiles')
      .select('id')
      .or(`email.ilike.%${q}%,full_name.ilike.%${q}%`)
      .limit(200)
    searchIds = (matches ?? []).map(m => m.id)
  }

  let query = supabase.from('orders').select('*', { count: 'exact' })
  if (status === 'refund') query = query.gt('refunded_usd', 0)
  else if (status) query = query.eq('payment_status', status)
  if (searchIds) query = searchIds.length ? query.in('user_id', searchIds) : query.in('user_id', ['00000000-0000-0000-0000-000000000000'])
  const from = (page - 1) * PAGE_SIZE
  const { data: orders, count } = await query.order('created_at', { ascending: false }).range(from, from + PAGE_SIZE - 1)

  const userIds = [...new Set(orders?.map(o => o.user_id).filter(Boolean) ?? [])]
  const { data: profiles } = userIds.length > 0
    ? await supabase.from('profiles').select('id, email, full_name').in('id', userIds)
    : { data: [] }
  const profileMap = Object.fromEntries((profiles ?? []).map(p => [p.id, p]))

  const chip = (active: boolean) => `text-xs font-mono px-3 py-1.5 rounded-full border transition-all ${active ? 'bg-ink text-white border-ink' : 'border-border text-ink2 hover:border-ink2'}`
  const hrefFor = (s: string) => {
    const p = new URLSearchParams()
    if (q) p.set('q', q)
    if (s) p.set('status', s)
    const qs = p.toString()
    return qs ? `/admin/orders?${qs}` : '/admin/orders'
  }

  return (
    <div className="max-w-6xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">Orders</h1>
        <p className="text-muted text-sm mt-1">All purchase activity across the platform</p>
      </div>

      {statsRes.error && (
        <div className="bg-red-50 border border-red-200 text-red-600 text-xs font-mono rounded-xl px-4 py-3 mb-6">
          Revenue stats unavailable — has migration 0043_admin_hardening.sql been run?
        </div>
      )}

      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="bg-white border border-border rounded-xl p-5">
          <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-2">Total revenue (net of refunds)</div>
          <div className="font-display text-3xl font-bold text-accent2">{stats ? `$${Number(stats.revenue_usd).toFixed(2)}` : '—'}</div>
        </div>
        <div className="bg-white border border-border rounded-xl p-5">
          <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-2">Total GB sold (net)</div>
          <div className="font-display text-3xl font-bold text-accent">{stats ? `${formatGb(Number(stats.gb_sold))} GB` : '—'}</div>
        </div>
        <div className="bg-white border border-border rounded-xl p-5">
          <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-2">Paid orders</div>
          <div className="font-display text-3xl font-bold text-ink">{stats ? stats.order_count : '—'}</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <Link href={hrefFor('')} className={chip(!status)}>All</Link>
        {FILTERS.map(f => <Link key={f} href={hrefFor(f)} className={chip(status === f)}>{f === 'refund' ? 'has refund' : f}</Link>)}
        <form method="get" className="ml-auto flex gap-2">
          {status && <input type="hidden" name="status" value={status} />}
          <input name="q" defaultValue={q} placeholder="Search customer email or name…"
            className="w-64 bg-white border border-border px-3 py-1.5 rounded-lg text-sm focus:outline-none focus:border-accent" />
          <button className="text-xs font-mono px-3 py-1.5 rounded-lg border border-border text-ink2 hover:border-ink2">Search</button>
        </form>
      </div>

      <div className="bg-white border border-border rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-surface">
              {['Date', 'User', 'GB', 'Amount', 'Refunded', 'Invoice', 'Status'].map(h => (
                <th key={h} className="text-left px-6 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(orders ?? []).length === 0 && (
              <tr><td colSpan={7} className="px-6 py-12 text-center text-sm text-muted">No orders match.</td></tr>
            )}
            {orders?.map((o) => {
              const profile = o.user_id ? profileMap[o.user_id] : null
              const refunded = Number(o.refunded_usd ?? 0)
              return (
                <tr key={o.id} className="border-b border-border hover:bg-surface">
                  <td className="px-6 py-4 text-xs font-mono text-muted">{new Date(o.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                  <td className="px-6 py-4">
                    <div className="text-sm text-ink">{profile?.full_name || 'Deleted user'}</div>
                    <div className="text-xs font-mono text-muted">{profile?.email || '-'}</div>
                  </td>
                  <td className="px-6 py-4 font-mono text-sm font-medium text-ink">{o.gb_amount} GB</td>
                  <td className="px-6 py-4 font-mono text-sm text-ink">${o.amount_usd}</td>
                  <td className="px-6 py-4 font-mono text-sm">{refunded > 0 ? <span className="text-red-500">−${refunded.toFixed(2)}</span> : <span className="text-muted">—</span>}</td>
                  <td className="px-6 py-4 font-mono text-xs text-muted">{o.invoice_number ?? '—'}</td>
                  <td className="px-6 py-4">
                    <span className={`text-[10px] font-mono px-2.5 py-1 rounded-full ${o.payment_status === 'paid' ? 'bg-accent2-light text-accent2' : o.payment_status === 'pending' ? 'bg-yellow-50 text-yellow-600' : 'bg-red-50 text-red-400'}`}>
                      {/* failure_reason only exists on orders the webhook's
                          charge.failed handler touched (migration 0036); a
                          stale 'pending' order the cleanup cron flipped to
                          'failed' has none, so it shows plain "failed". */}
                      {o.payment_status === 'failed' && o.failure_reason
                        ? `failed - ${o.failure_reason.toLowerCase()}`
                        : o.payment_status}
                    </span>
                    {o.is_canary && <div className="text-[10px] font-mono text-muted mt-1">canary test</div>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <AdminPager basePath="/admin/orders" page={page} pageSize={PAGE_SIZE} total={count ?? 0} params={{ q, status }} />
    </div>
  )
}
