'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'
import { formatGb, formatUsd } from '@/lib/format'
import { PLANS } from '@/lib/plans'
import BillingDetailsForm from '@/components/dashboard/BillingDetailsForm'
import ExportButton from '@/components/dashboard/ExportButton'

export default function BillingPage() {
  const [orders, setOrders] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)
  // Credit notes (one per refund) and the customer's refund requests, by order.
  const [notes, setNotes] = useState<Record<string, { number: string; amount: number }[]>>({})
  const [requests, setRequests] = useState<Record<string, { status: string; note: string | null }>>({})
  const [requesting, setRequesting] = useState<string | null>(null)

  // PostgREST caps a single response (1000 rows by default) and reports
  // nothing when it truncates — page through so history and totals are
  // complete, and surface failures instead of showing "No orders yet".
  async function load() {
    setLoading(true)
    setLoadError(false)
    try {
      const sb = createClient()
      const { data: { user } } = await sb.auth.getUser()
      // Expired session: go sign in again rather than showing a misleading empty history.
      if (!user) { window.location.href = '/auth/login'; return }
      const PAGE = 1000
      const all: any[] = []
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await sb
          .from('orders')
          .select('id, created_at, gb_amount, amount_usd, refunded_usd, payment_status, payment_method, pay_amount, pay_currency, failure_reason')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, from + PAGE - 1)
        if (error) throw error
        all.push(...(data ?? []))
        if ((data?.length ?? 0) < PAGE) break
      }
      setOrders(all)

      // Credit notes and refund requests ride along; a failed read just omits
      // them (the order history above is what matters).
      const [{ data: refunds }, { data: reqs }] = await Promise.all([
        sb.from('order_refunds').select('order_id, credit_note_number, amount_usd').order('created_at', { ascending: true }).limit(1000),
        sb.from('refund_requests').select('order_id, status, decline_note, created_at').order('created_at', { ascending: true }).limit(1000),
      ])
      const n: Record<string, { number: string; amount: number }[]> = {}
      for (const r of refunds ?? []) (n[r.order_id] ??= []).push({ number: r.credit_note_number, amount: Number(r.amount_usd) })
      setNotes(n)
      // Ascending, so the latest request per order wins.
      const q: Record<string, { status: string; note: string | null }> = {}
      for (const r of reqs ?? []) q[r.order_id] = { status: r.status, note: r.decline_note ?? null }
      setRequests(q)
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

  async function requestRefund(o: any) {
    const reason = window.prompt(
      `Request a refund of ${formatUsd(Number(o.amount_usd) - Number(o.refunded_usd ?? 0))} for this ${o.gb_amount} GB order.\n\n` +
      'Refunds are available within 72 hours of purchase if no bandwidth has been used (see the refund policy). Why are you asking for a refund?', '')
    if (reason === null) return
    if (reason.trim().length < 3) { toast.error('Please tell us briefly why you are asking for a refund.'); return }
    setRequesting(o.id)
    try {
      const res = await fetch('/api/dashboard/billing/refund-request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: o.id, reason }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) toast.error(d.error || 'Could not send your refund request')
      else {
        toast.success(d.within_policy ? 'Refund request sent — it falls inside our refund window. We reply within 2 business days.' : 'Refund request sent — it is outside our standard window, so we will review it. We reply within 2 business days.', { duration: 8000 })
        setRequests(prev => ({ ...prev, [o.id]: { status: 'open', note: null } }))
      }
    } catch {
      toast.error('Could not send your refund request')
    }
    setRequesting(null)
  }

  const paid = orders.filter(o => o.payment_status === 'paid')
  // Net of partial refunds; fully refunded orders have their own status and aren't in `paid`.
  const totalSpent = paid.reduce((s, o) => s + Number(o.amount_usd) - Number(o.refunded_usd ?? 0), 0)
  // Same net basis as "Total spent": a partial refund also took its share of
  // the bandwidth back.
  const totalGb = paid.reduce((s, o) => {
    const amt = Number(o.amount_usd)
    const kept = amt > 0 ? Math.max(amt - Number(o.refunded_usd ?? 0), 0) / amt : 1
    return s + Number(o.gb_amount) * kept
  }, 0)

  return (
    <div className="max-w-4xl">
      <div className="flex items-start justify-between gap-4 mb-8 flex-wrap">
        <div>
          <h1 className="font-display font-bold text-2xl text-ink">Billing</h1>
          <p className="text-muted text-sm mt-1">Your order history and spend</p>
        </div>
        {!loading && !loadError && orders.length > 0 && (
          <ExportButton
            url="/api/dashboard/billing/export" filename="globproxy-orders.csv"
            className="text-sm font-medium text-ink2 border border-border hover:border-accent hover:text-accent px-4 py-2 rounded-xl transition-colors flex-shrink-0"
          >
            Export CSV ↓
          </ExportButton>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        {[
          ['Total spent', formatUsd(totalSpent)],
          ['Total GB purchased (net)', `${formatGb(totalGb)} GB`],
          ['Total orders', String(paid.length)],
        ].map(([l, v]) => (
          <div key={l} className="bg-white border border-border rounded-xl p-5">
            <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-2">{l}</div>
            <div className="font-display text-3xl font-bold text-ink">{v}</div>
          </div>
        ))}
      </div>

      <BillingDetailsForm />

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
                    {o.pay_currency && o.pay_currency !== 'USD' && o.pay_amount != null && (
                      <div className="text-[10px] text-muted">{o.pay_currency} {Number(o.pay_amount).toLocaleString('en-KE')} via M-Pesa</div>
                    )}
                    {Number(o.refunded_usd ?? 0) > 0 && (
                      <div className="text-[10px] text-red-400">−{formatUsd(o.refunded_usd)} refunded</div>
                    )}
                    {(notes[o.id] ?? []).map(n => (
                      <div key={n.number} className="text-[10px]">
                        <a href={`/invoice/${o.id}/credit/${n.number}`} target="_blank" rel="noopener noreferrer" className="text-muted hover:text-accent underline">
                          Credit note {n.number}
                        </a>
                      </div>
                    ))}
                  </td>
                  <td className="px-6 py-4">
                    <span className={`text-[10px] font-mono px-2.5 py-1 rounded-full ${
                      o.payment_status === 'paid' ? 'bg-accent2-light text-accent2' :
                      o.payment_status === 'pending' ? 'bg-yellow-50 text-yellow-600' :
                      'bg-red-50 text-red-400'
                    }`}>
                      {o.payment_status}
                    </span>
                    {requests[o.id]?.status === 'open' && (
                      <div className="text-[10px] text-amber-700 mt-1">Refund requested</div>
                    )}
                    {requests[o.id]?.status === 'declined' && (
                      <div className="text-[10px] text-muted mt-1 max-w-[180px]" title={requests[o.id]?.note ?? undefined}>Refund request declined</div>
                    )}
                    {o.payment_status === 'failed' && o.failure_reason && (
                      <div className="text-[10px] text-muted mt-1 max-w-[180px] truncate" title={o.failure_reason}>{o.failure_reason}</div>
                    )}
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
                    {o.payment_status === 'paid' && !o.is_canary && requests[o.id]?.status !== 'open'
                      && Number(o.amount_usd) - Number(o.refunded_usd ?? 0) > 0.005 && (
                      <button
                        onClick={() => requestRefund(o)}
                        disabled={requesting === o.id}
                        className="text-[10px] font-mono text-muted hover:text-ink border border-border hover:border-ink2 px-3 py-1 rounded-lg transition-colors disabled:opacity-50 mr-2"
                      >
                        {requesting === o.id ? 'Sending…' : 'Request refund'}
                      </button>
                    )}
                    {(o.payment_status === 'pending' || o.payment_status === 'failed') && (() => {
                      // Re-open the buy page on the same selection: a fixed plan when
                      // the order matches one exactly, otherwise a custom quantity.
                      const plan = PLANS.find(p => !p.custom && p.gb === Number(o.gb_amount) && p.total === Number(o.amount_usd))
                      const gbInt = Number(o.gb_amount)
                      const sel = plan ? `plan=${plan.slug}` : Number.isInteger(gbInt) ? `plan=custom&gb=${gbInt}` : null
                      return sel ? (
                        <Link
                          href={`/dashboard/buy?${sel}${o.payment_method === 'mpesa' ? '&method=mpesa' : ''}`}
                          className="text-[10px] font-mono text-accent hover:underline border border-accent/30 px-3 py-1 rounded-lg inline-block mr-2"
                        >
                          {o.payment_status === 'pending' ? 'Pay now' : 'Try again'}
                        </Link>
                      ) : null
                    })()}
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
