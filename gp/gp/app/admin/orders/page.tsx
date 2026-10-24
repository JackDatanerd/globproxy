import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/server'
import AdminQueryError from '@/components/admin/AdminQueryError'
import AdminOrdersExport from '@/components/admin/AdminOrdersExport'
import AdminPager, { parsePage, cleanSearch } from '@/components/admin/AdminPager'
import { formatGb } from '@/lib/format'
import AdminRefundButton from '@/components/admin/AdminRefundButton'
import { AdminVerifyOrderButton, AdminDisputeButtons, AdminDeclineRequestButton } from '@/components/admin/AdminOrderActions'

const PAGE_SIZE = 50
// 'refund' = any order with money refunded (partial refunds keep status 'paid').
// 'disputed' = a Paystack chargeback is open on the order (migration 0047).
// 'refund_requested' = the customer asked for a refund from Billing (migration 0062).
// 'uncredited' = not credited yet but has a payment reference (candidates for Verify & credit).
// 'unfulfilled' = marked PAID but the bandwidth was never credited (the customer paid and got nothing).
const FILTERS = ['paid', 'pending', 'failed', 'cancelled', 'refunded', 'refund', 'disputed', 'refund_requested', 'uncredited', 'unfulfilled'] as const

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

  let requestOrderIds: string[] = []
  if (status === 'refund_requested') {
    const { data: open } = await supabase.from('refund_requests').select('order_id').eq('status', 'open').limit(500)
    requestOrderIds = (open ?? []).map(r => r.order_id)
  }

  let query = supabase.from('orders').select('*', { count: 'exact' })
  if (status === 'refund') query = query.gt('refunded_usd', 0)
  else if (status === 'disputed') query = query.eq('dispute_status', 'open')
  else if (status === 'refund_requested') query = requestOrderIds.length ? query.in('id', requestOrderIds) : query.in('id', ['00000000-0000-0000-0000-000000000000'])
  else if (status === 'uncredited') query = query.eq('bandwidth_credited', false).in('payment_status', ['pending', 'failed', 'cancelled']).not('paystack_reference', 'is', null).eq('is_canary', false)
  else if (status === 'unfulfilled') query = query.eq('payment_status', 'paid').eq('bandwidth_credited', false).eq('is_canary', false)
  else if (status) query = query.eq('payment_status', status)
  if (searchIds) query = searchIds.length ? query.in('user_id', searchIds) : query.in('user_id', ['00000000-0000-0000-0000-000000000000'])
  const from = (page - 1) * PAGE_SIZE
  const { data: orders, count, error: listErr } = await query.order('created_at', { ascending: false }).range(from, from + PAGE_SIZE - 1)

  const userIds = [...new Set(orders?.map(o => o.user_id).filter(Boolean) ?? [])]
  const { data: profiles } = userIds.length > 0
    ? await supabase.from('profiles').select('id, email, full_name').in('id', userIds)
    : { data: [] }
  const profileMap = Object.fromEntries((profiles ?? []).map(p => [p.id, p]))

  // Open refund requests for the orders on this page (customer → Billing → Request refund).
  const pageOrderIds = (orders ?? []).map(o => o.id)
  const { data: openRequests } = pageOrderIds.length
    ? await supabase.from('refund_requests').select('id, order_id, reason, within_policy, created_at').eq('status', 'open').in('order_id', pageOrderIds)
    : { data: [] }
  const requestByOrder = Object.fromEntries((openRequests ?? []).map(r => [r.order_id, r]))

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
      {listErr && <AdminQueryError what="orders" />}
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">Orders</h1>
        <p className="text-muted text-sm mt-1">All purchase activity across the platform</p>
      </div>

      {statsRes.error && (
        <div className="bg-red-50 border border-red-200 text-red-600 text-xs font-mono rounded-xl px-4 py-3 mb-6">
          Revenue stats unavailable — have migrations 0043 and 0052 been run?
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
        {FILTERS.map(f => <Link key={f} href={hrefFor(f)} className={chip(status === f)}>{f === 'refund' ? 'has refund' : f === 'disputed' ? 'open dispute' : f === 'refund_requested' ? 'refund requested' : f === 'uncredited' ? 'paid? (uncredited)' : f === 'unfulfilled' ? 'paid, not credited' : f}</Link>)}
        <form method="get" className="ml-auto flex gap-2">
          {status && <input type="hidden" name="status" value={status} />}
          <input name="q" defaultValue={q} placeholder="Search customer email or name…"
            className="w-64 bg-white border border-border px-3 py-1.5 rounded-lg text-sm focus:outline-none focus:border-accent" />
          <button className="text-xs font-mono px-3 py-1.5 rounded-lg border border-border text-ink2 hover:border-ink2">Search</button>
        </form>
      </div>

      <div className="flex justify-end mb-3">
        <AdminOrdersExport status={['paid', 'pending', 'failed', 'cancelled', 'refunded', 'refund', 'disputed', 'uncredited', 'unfulfilled'].includes(status) ? status : ''} q={q} />
      </div>

      <div className="bg-white border border-border rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-surface">
              {['Date', 'User', 'GB', 'Amount', 'Refunded', 'Invoice', 'Status', ''].map(h => (
                <th key={h} className="text-left px-6 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(orders ?? []).length === 0 && (
              <tr><td colSpan={8} className="px-6 py-12 text-center text-sm text-muted">No orders match.</td></tr>
            )}
            {orders?.map((o) => {
              const profile = o.user_id ? profileMap[o.user_id] : null
              const refunded = Number(o.refunded_usd ?? 0)
              return (
                <tr key={o.id} className="border-b border-border hover:bg-surface">
                  <td className="px-6 py-4 text-xs font-mono text-muted">{new Date(o.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                  <td className="px-6 py-4">
                    <div className="text-sm text-ink">
                      {o.user_id
                        ? <Link href={`/admin/users/${o.user_id}`} className="hover:text-accent">{profile?.full_name || 'Deleted user'}</Link>
                        : (profile?.full_name || 'Deleted user')}
                    </div>
                    <div className="text-xs font-mono text-muted">{profile?.email || '-'}</div>
                  </td>
                  <td className="px-6 py-4 font-mono text-sm font-medium text-ink">{o.gb_amount} GB</td>
                  <td className="px-6 py-4 font-mono text-sm text-ink">
                    ${Number(o.amount_usd).toFixed(2)}
                    {o.pay_currency && o.pay_currency !== 'USD' && o.pay_amount != null && (
                      <div className="text-[10px] text-muted">{o.pay_currency} {Number(o.pay_amount).toLocaleString('en-KE')} · M-Pesa</div>
                    )}
                  </td>
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
                    {/* Paystack chargebacks (migration 0047): previously only a filter —
                        the dispute itself was never shown on the order. */}
                    {o.dispute_status === 'open' && (
                      <div className="text-[10px] font-mono text-red-600 mt-1">
                        ⚠ dispute open{o.dispute_opened_at ? ` since ${new Date(o.dispute_opened_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}` : ''}
                      </div>
                    )}
                    {(o.dispute_status === 'resolved' || o.dispute_status === 'lost' || o.dispute_status === 'won') && (
                      <div className={`text-[10px] font-mono mt-1 ${o.dispute_status === 'lost' ? 'text-red-600' : 'text-muted'}`}>
                        dispute {o.dispute_status === 'resolved' ? 'resolved (outcome not recorded)' : o.dispute_status}{o.dispute_resolution ? ` — ${o.dispute_resolution}` : ''}
                      </div>
                    )}
                    {requestByOrder[o.id] && (
                      <div className="text-[10px] font-mono text-amber-700 mt-1 max-w-[220px]">
                        ✋ refund requested{requestByOrder[o.id].within_policy ? ' · within policy' : ' · outside policy'}
                        <div className="text-muted break-words whitespace-normal">“{requestByOrder[o.id].reason}”</div>
                      </div>
                    )}
                    {o.paystack_reference && <div className="text-[10px] font-mono text-muted mt-1 break-all">{o.paystack_reference}</div>}
                  </td>
                  <td className="px-6 py-4 text-right space-y-1.5">
                    {!o.is_canary && !o.bandwidth_credited && o.paystack_reference && ['pending', 'failed', 'cancelled'].includes(o.payment_status) && (
                      <div><AdminVerifyOrderButton orderId={o.id} email={profile?.email || 'this customer'} /></div>
                    )}
                    {(o.dispute_status === 'open' || o.dispute_status === 'resolved') && !o.is_canary && (
                      <div><AdminDisputeButtons orderId={o.id} email={profile?.email || 'this customer'} /></div>
                    )}
                    {requestByOrder[o.id] && (
                      <div><AdminDeclineRequestButton requestId={requestByOrder[o.id].id} email={profile?.email || 'this customer'} /></div>
                    )}
                    {o.payment_status === 'paid' && !o.is_canary && o.paystack_reference && Number(o.amount_usd) - refunded > 0.005 && (
                      <div><AdminRefundButton orderId={o.id} remainingUsd={Math.round((Number(o.amount_usd) - refunded) * 100) / 100} email={profile?.email || 'this customer'} /></div>
                    )}
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
