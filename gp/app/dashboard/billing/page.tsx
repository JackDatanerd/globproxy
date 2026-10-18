'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'
import { formatGb, formatUsd } from '@/lib/format'

export default function BillingPage() {
  const [orders, setOrders] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)

  // PostgREST caps a single response (1000 rows by default) and reports
  // nothing when it truncates — page through so history and totals are
  // complete, and surface failures instead of showing "No orders yet".
  async function load() {
    setLoading(true)
    setLoadError(false)
    try {
      const sb = createClient()
      const { data: { user } } = await sb.auth.getUser()
      if (!user) return
      const PAGE = 1000
      const all: any[] = []
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await sb
          .from('orders')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, from + PAGE - 1)
        if (error) throw error
        all.push(...(data ?? []))
        if ((data?.length ?? 0) < PAGE) break
      }
      setOrders(all)
    } catch (e) {
      console.error('[billing] failed to load orders', e)
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function cancelOrder(orderId: string) {
    setCancelling(orderId)
    const sb = createClient()
    // .select() here is load-bearing, not decorative — Supabase does NOT
    // error on an update that matches 0 rows (RLS silently filtering, or
    // the order having already left 'pending' — paid, or cancelled from
    // another tab). Without it, a no-op update and a real one both come
    // back as `{ error: null }`, so this could show "Order cancelled" while
    // leaving the row untouched. Same pattern already used elsewhere in
    // this app (admin/suspend-user, dashboard/proxies/[id] DELETE, etc.).
    const { data: updated, error } = await sb
      .from('orders')
      .update({ payment_status: 'cancelled' })
      .eq('id', orderId)
      .eq('payment_status', 'pending') // safety — only cancel if still pending
      .select('id')

    if (error) {
      toast.error('Failed to cancel order')
    } else if (!updated || updated.length === 0) {
      toast.error('This order can no longer be cancelled — refresh to see its current status.')
    } else {
      toast.success('Order cancelled')
      setOrders(prev =>
        prev.map(o => o.id === orderId ? { ...o, payment_status: 'cancelled' } : o)
      )
    }
    setCancelling(null)
  }

  const paid = orders.filter(o => o.payment_status === 'paid')
  // Net of partial refunds; fully refunded orders have their own status and aren't in `paid`.
  const totalSpent = paid.reduce((s, o) => s + Number(o.amount_usd) - Number(o.refunded_usd ?? 0), 0)
  const totalGb = paid.reduce((s, o) => s + Number(o.gb_amount), 0)

  return (
    <div className="max-w-4xl">
      <div className="flex items-start justify-between gap-4 mb-8 flex-wrap">
        <div>
          <h1 className="font-display font-bold text-2xl text-ink">Billing</h1>
          <p className="text-muted text-sm mt-1">Your order history and spend</p>
        </div>
        {!loading && !loadError && orders.length > 0 && (
          <a
            href="/api/dashboard/billing/export"
            className="text-sm font-medium text-ink2 border border-border hover:border-accent hover:text-accent px-4 py-2 rounded-xl transition-colors flex-shrink-0"
          >
            Export CSV ↓
          </a>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        {[
          ['Total spent', formatUsd(totalSpent)],
          ['Total GB purchased', `${formatGb(totalGb)} GB`],
          ['Total orders', String(paid.length)],
        ].map(([l, v]) => (
          <div key={l} className="bg-white border border-border rounded-xl p-5">
            <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-2">{l}</div>
            <div className="font-display text-3xl font-bold text-ink">{v}</div>
          </div>
        ))}
      </div>

      {/* Orders table */}
      <div className="bg-white border border-border rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <h2 className="font-display font-bold text-base text-ink">Order history</h2>
        </div>

        {loading ? (
          <div className="text-center py-14 text-muted text-sm">Loading...</div>
        ) : loadError ? (
          <div className="text-center py-14">
            <p className="text-muted text-sm font-light">We couldn't load your orders.</p>
            <button onClick={load} className="text-accent text-sm hover:underline mt-1">Try again</button>
          </div>
        ) : orders.length > 0 ? (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-surface">
                {['Date', 'Bandwidth', 'Amount', 'Status', ''].map((h, i) => (
                  <th key={i} className="text-left px-6 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {orders.map((o, i) => (
                <tr key={o.id} className={`${i < orders.length - 1 ? 'border-b border-border' : ''} hover:bg-surface`}>
                  <td className="px-6 py-4 text-xs font-mono text-muted">
                    {new Date(o.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </td>
                  <td className="px-6 py-4 text-sm font-medium text-ink">{o.gb_amount} GB</td>
                  <td className="px-6 py-4 text-sm font-mono text-ink">
                    {formatUsd(o.amount_usd)}
                    {Number(o.refunded_usd ?? 0) > 0 && o.payment_status === 'paid' && (
                      <div className="text-[10px] text-red-400">−{formatUsd(o.refunded_usd)} refunded</div>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <span className={`text-[10px] font-mono px-2.5 py-1 rounded-full ${
                      o.payment_status === 'paid' ? 'bg-accent2-light text-accent2' :
                      o.payment_status === 'pending' ? 'bg-yellow-50 text-yellow-600' :
                      'bg-red-50 text-red-400'
                    }`}>
                      {o.payment_status}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right whitespace-nowrap">
                    {(o.payment_status === 'paid' || o.payment_status === 'refunded') && (
                      <a
                        href={`/invoice/${o.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] font-mono text-muted hover:text-accent border border-border hover:border-accent-light px-3 py-1 rounded-lg transition-colors inline-block"
                      >
                        Invoice
                      </a>
                    )}
                    {o.payment_status === 'pending' && (
                      <button
                        onClick={() => cancelOrder(o.id)}
                        disabled={cancelling === o.id}
                        className="text-[10px] font-mono text-muted hover:text-red-500 border border-border hover:border-red-200 px-3 py-1 rounded-lg transition-colors disabled:opacity-50"
                      >
                        {cancelling === o.id ? 'Cancelling...' : 'Cancel'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-center py-14">
            <p className="text-muted text-sm font-light">No orders yet.</p>
            <Link href="/dashboard/buy" className="text-accent text-sm hover:underline mt-1 block">
              Buy your first bandwidth →
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}
