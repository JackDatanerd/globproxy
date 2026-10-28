'use client'
import { redirectToMfa } from '@/lib/clientApi'
import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'
import { formatGb, formatUsd } from '@/lib/format'
import { PLANS } from '@/lib/plans'
import BillingDetailsForm from '@/components/dashboard/BillingDetailsForm'
import AutoRechargePanel from '@/components/dashboard/AutoRechargePanel'
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
  const [refundFor, setRefundFor] = useState<any | null>(null)
  const [refundReason, setRefundReason] = useState('')
  // Set when a lost chargeback has put the account on hold (new purchases blocked).
  const [hold, setHold] = useState(false)
  // History controls: accounts with years of orders (or auto-recharge) otherwise get one
  // endless table. Filtering and paging are display-only; the totals above use every order.
  const [statusFilter, setStatusFilter] = useState<'all' | 'paid' | 'pending' | 'failed' | 'cancelled' | 'refunded'>('all')
  const [visible, setVisible] = useState(25)
  const dialogRef = useRef<HTMLDivElement>(null)

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
          .select('id, created_at, gb_amount, amount_usd, refunded_usd, payment_status, payment_method, pay_amount, pay_currency, failure_reason, dispute_status, auto_recharge, is_canary')
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
      const [{ data: refunds }, { data: reqs }, { data: holdRow }] = await Promise.all([
        sb.from('order_refunds').select('order_id, credit_note_number, amount_usd').order('created_at', { ascending: true }).limit(1000),
        sb.from('refund_requests').select('order_id, status, decline_note, created_at').order('created_at', { ascending: true }).limit(1000),
        sb.from('payment_holds').select('user_id').eq('user_id', user.id).maybeSingle(),
      ])
      setHold(!!holdRow)
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

  // Refund dialog: Escape closes it (unless a request is in flight) and Tab stays inside it.
  useEffect(() => {
    if (!refundFor) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !requesting) { setRefundFor(null); return }
      if (e.key !== 'Tab') return
      const f = dialogRef.current?.querySelectorAll<HTMLElement>('textarea, button:not([disabled])')
      if (!f || f.length === 0) return
      const first = f[0], last = f[f.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [refundFor, requesting])

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

  async function requestRefund(o: any, reason: string) {
    if (reason.trim().length < 3) { toast.error('Please tell us briefly why you are asking for a refund.'); return }
    setRequesting(o.id)
    try {
      const res = await fetch('/api/dashboard/billing/refund-request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: o.id, reason }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (res.status === 403 && d?.code === 'mfa_required') redirectToMfa(d)
        else toast.error(d.error || 'Could not send your refund request')
      } else {
        toast.success(d.within_policy ? 'Refund request sent — it falls inside our refund window. We reply within 2 business days.' : 'Refund request sent — it is outside our standard window, so we will review it. We reply within 2 business days.', { duration: 8000 })
        setRequests(prev => ({ ...prev, [o.id]: { status: 'open', note: null } }))
        setRefundFor(null); setRefundReason('')
      }
    } catch {
      toast.error('Could not send your refund request')
    }
    setRequesting(null)
  }

  const filteredOrders = statusFilter === 'all' ? orders : orders.filter(o => o.payment_status === statusFilter)
  const shownOrders = filteredOrders.slice(0, visible)
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

      {(hold || orders.some(o => o.dispute_status === 'open')) && (
        <div className="mb-6 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl px-4 py-3 text-sm">
          {hold
            ? 'New purchases are on hold on this account after a payment dispute that was decided against it. Write to support@globproxy.com and we will review it.'
            : 'Your bank has disputed a payment on this account. New purchases are paused until the dispute is decided; your existing bandwidth keeps working. Questions: support@globproxy.com.'}
        </div>
      )}

      {refundFor && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4" onClick={() => { if (!requesting) setRefundFor(null) }}>
          <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Request a refund" className="bg-white border border-border rounded-xl p-5 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <div className="text-sm font-medium text-ink mb-1">Request a refund of {formatUsd(Number(refundFor.amount_usd) - Number(refundFor.refunded_usd ?? 0))}</div>
            <div className="text-xs text-muted mb-3">For the {refundFor.gb_amount} GB order. Refunds are available within 72 hours of purchase if no bandwidth has been used (see the refund policy). Why are you asking for a refund?</div>
            <textarea autoFocus value={refundReason} onChange={e => setRefundReason(e.target.value)} rows={4} maxLength={500}
              className="w-full text-sm text-ink bg-surface border border-border rounded-lg px-3 py-2 mb-3" placeholder="A sentence is enough" />
            <div className="flex gap-2">
              <button onClick={() => requestRefund(refundFor, refundReason)} disabled={!!requesting || refundReason.trim().length < 3}
                className="text-xs font-mono px-4 py-2 rounded-lg border border-accent bg-accent text-white disabled:opacity-50">{requesting ? 'Sending…' : 'Send request'}</button>
              <button onClick={() => setRefundFor(null)} disabled={!!requesting} className="text-xs font-mono px-4 py-2 rounded-lg border border-border text-muted">Cancel</button>
            </div>
          </div>
        </div>
      )}

      <AutoRechargePanel />
      <BillingDetailsForm />

      {/* Orders table */}
      <div className="bg-white border border-border rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
          <h2 className="font-display font-bold text-base text-ink">Order history</h2>
          {!loading && !loadError && orders.length > 0 && (
            <div className="flex gap-1.5 flex-wrap" role="group" aria-label="Filter orders by status">
              {(['all', 'paid', 'pending', 'failed', 'cancelled', 'refunded'] as const).map(st => {
                const n = st === 'all' ? orders.length : orders.filter(o => o.payment_status === st).length
                if (st !== 'all' && n === 0 && statusFilter !== st) return null
                return (
                  <button key={st} onClick={() => { setStatusFilter(st); setVisible(25) }} aria-pressed={statusFilter === st}
                    className={`text-[11px] font-mono px-3 py-1 rounded-full border transition-colors ${statusFilter === st ? 'bg-ink text-white border-ink' : 'bg-white text-ink2 border-border hover:border-ink2/40'}`}>
                    {st === 'all' ? 'All' : st[0].toUpperCase() + st.slice(1)} <span className="opacity-60">({n})</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {loading ? (
          <div className="text-center py-14 text-muted text-sm">Loading...</div>
        ) : loadError ? (
          <div className="text-center py-14">
            <p className="text-muted text-sm font-light">We couldn't load your orders.</p>
            <button onClick={load} className="text-accent text-sm hover:underline mt-1">Try again</button>
          </div>
        ) : orders.length > 0 ? (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead>
              <tr className="border-b border-border bg-surface">
                {['Date', 'Bandwidth', 'Amount', 'Status', ''].map((h, i) => (
                  <th key={i} className="text-left px-6 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shownOrders.map((o, i) => (
                <tr key={o.id} className={`${i < shownOrders.length - 1 ? 'border-b border-border' : ''} hover:bg-surface`}>
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
                      o.payment_status === 'cancelled' || o.payment_status === 'refunded' ? 'bg-surface text-muted border border-border' :
                      'bg-red-50 text-red-400'
                    }`}>
                      {o.payment_status}
                    </span>
                    {o.dispute_status === 'open' && <div className="text-[10px] text-amber-700 mt-1">Payment disputed</div>}
                    {o.auto_recharge && <div className="text-[10px] text-muted mt-1">Auto-recharge</div>}
                    {requests[o.id]?.status === 'open' && (
                      <div className="text-[10px] text-amber-700 mt-1">Refund requested</div>
                    )}
                    {requests[o.id]?.status === 'declined' && (
                      <div className="text-[10px] text-muted mt-1 max-w-[180px]" title={requests[o.id]?.note ?? undefined}>
                        Refund request declined{requests[o.id]?.note ? <span className="block whitespace-normal text-ink2">{requests[o.id]?.note}</span> : null}
                      </div>
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
                        onClick={() => { setRefundReason(''); setRefundFor(o) }}
                        disabled={requesting === o.id}
                        className="text-[10px] font-mono text-muted hover:text-ink border border-border hover:border-ink2 px-3 py-1 rounded-lg transition-colors disabled:opacity-50 mr-2"
                      >
                        {requesting === o.id ? 'Sending…' : 'Request refund'}
                      </button>
                    )}
                    {(o.payment_status === 'failed' || (o.payment_status === 'pending' && !o.auto_recharge)) && (() => {
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
                          {o.payment_status === 'pending' ? 'Pay again' : 'Try again'}
                        </Link>
                      ) : null
                    })()}
                    {/* An automatic top-up already sent to the card is not a checkout the customer can abandon: cancelling the label would not stop the charge and hides it from the 30-day limit. */}
                    {o.payment_status === 'pending' && !o.auto_recharge && (
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
          {filteredOrders.length === 0 && (
            <div className="text-center py-10 text-sm text-muted font-light">No {statusFilter} orders.</div>
          )}
          {filteredOrders.length > shownOrders.length && (
            <div className="px-6 py-4 border-t border-border text-center">
              <button onClick={() => setVisible(v => v + 25)} className="text-sm text-accent hover:underline">
                Show more ({filteredOrders.length - shownOrders.length} older)
              </button>
            </div>
          )}
          </div>
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
