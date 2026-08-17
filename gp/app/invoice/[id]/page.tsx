import { createClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import InvoiceActions from '@/components/InvoiceActions'

// Private financial documents — never indexed, never cached across users.
export const metadata = { title: 'Invoice — GlobProxy', robots: { index: false, follow: false } }

function formatDate(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  // Belt-and-suspenders: middleware.ts already gates this path (it's in
  // isProtected) for the not-logged-in and mandatory-MFA-for-admin/
  // reseller cases, the same way dashboard/layout.tsx re-checks
  // suspension/MFA despite middleware already handling it.
  if (!user) redirect(`/auth/login?next=/invoice/${id}`)

  // createClient() is the cookie/JWT client, not the admin client — RLS's
  // "Own orders" select policy (auth.uid() = user_id) already scopes this
  // to the caller's own orders. The explicit .eq('user_id', user.id) below
  // is redundant with that policy but kept for the same reason every other
  // page in this app keeps it: defense-in-depth if RLS is ever
  // misconfigured, and it documents the intent inline.
  const { data: order } = await supabase
    .from('orders')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .single()

  if (!order) notFound()

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, company_name, email')
    .eq('id', user.id)
    .single()

  // Nothing was actually invoiced yet for a pending/failed/cancelled
  // order — no invoice_number was ever assigned (see migration 0021), so
  // there's genuinely nothing to render. This is reachable if someone
  // saves/revisits the link before payment completes; it isn't a 404,
  // it's a "not yet" — the Billing page only ever links here for orders
  // that already are paid/refunded.
  if (!['paid', 'refunded'].includes(order.payment_status)) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center p-6">
        <div className="text-center max-w-sm">
          <p className="text-ink font-display font-semibold text-lg mb-1.5">No invoice yet</p>
          <p className="text-muted text-sm mb-5">
            This order is currently <span className="font-mono">{order.payment_status}</span> — an invoice
            is generated once payment is confirmed.
          </p>
          <Link href="/dashboard/billing" className="text-accent text-sm hover:underline">← Back to Billing</Link>
        </div>
      </div>
    )
  }

  const isRefunded = order.payment_status === 'refunded'
  const billedName = profile?.full_name || profile?.email || 'Customer'

  return (
    <div className="min-h-screen bg-surface py-10 px-6 print:bg-white print:py-0 print:px-0">
      <InvoiceActions />

      <div className="max-w-2xl mx-auto bg-white border border-border rounded-2xl print:border-0 print:rounded-none p-10 print:p-0 relative">
        {isRefunded && (
          <div className="absolute top-8 right-10 text-red-300 border-2 border-red-300 rounded px-3 py-1 text-xs font-bold uppercase tracking-widest rotate-6 select-none">
            Refunded
          </div>
        )}

        {/* Header */}
        <div className="flex items-start justify-between mb-10">
          <div>
            <div className="font-display font-bold text-xl text-ink">GlobProxy</div>
            <div className="text-[11px] text-muted mt-0.5">Residential Proxies That Never Expire</div>
          </div>
          <div className="text-right">
            <div className="font-display font-bold text-lg text-ink">INVOICE</div>
            <div className="text-xs font-mono text-muted mt-1">{order.invoice_number ?? `#${order.id.slice(0, 8)}`}</div>
          </div>
        </div>

        {/* From / Bill to */}
        <div className="grid grid-cols-2 gap-6 mb-10">
          <div>
            <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-1.5">From</div>
            <div className="text-sm text-ink font-medium">Saltern Studio</div>
            <div className="text-sm text-ink2">trading as GlobProxy</div>
            <div className="text-sm text-ink2"></div>
            <div className="text-sm text-ink2">support@globproxy.com</div>
          </div>
          <div>
            <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-1.5">Billed to</div>
            <div className="text-sm text-ink font-medium">{billedName}</div>
            {profile?.company_name && <div className="text-sm text-ink2">{profile.company_name}</div>}
            <div className="text-sm text-ink2">{profile?.email}</div>
          </div>
        </div>

        {/* Meta */}
        <div className="grid grid-cols-3 gap-4 mb-8 text-sm">
          <div>
            <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-1">Invoice date</div>
            <div className="text-ink">{formatDate(order.paid_at ?? order.created_at)}</div>
          </div>
          <div>
            <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-1">Payment method</div>
            <div className="text-ink capitalize">{order.payment_method}</div>
          </div>
          <div>
            <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-1">Status</div>
            <div className={isRefunded ? 'text-red-500 font-medium' : 'text-accent2 font-medium'}>
              {isRefunded ? 'Refunded' : 'Paid'}
            </div>
          </div>
        </div>

        {/* Line items */}
        <table className="w-full mb-6">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left text-[10px] font-mono text-muted uppercase tracking-widest pb-2">Description</th>
              <th className="text-right text-[10px] font-mono text-muted uppercase tracking-widest pb-2">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border">
              <td className="py-4 text-sm text-ink">
                {order.gb_amount} GB residential proxy bandwidth
                <div className="text-xs text-muted mt-0.5">Non-expiring — no subscription</div>
              </td>
              <td className="py-4 text-sm text-ink text-right font-mono">${Number(order.amount_usd).toFixed(2)}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td className="pt-4 text-sm font-semibold text-ink text-right">Total (USD)</td>
              <td className="pt-4 text-sm font-semibold text-ink text-right font-mono">${Number(order.amount_usd).toFixed(2)}</td>
            </tr>
          </tfoot>
        </table>

        {order.paystack_reference && (
          <div className="text-[11px] font-mono text-muted mb-8">
            Payment reference: {order.paystack_reference}
          </div>
        )}

        <div className="border-t border-border pt-6 text-center">
          <p className="text-xs text-muted">Questions about this invoice? support@globproxy.com</p>
          <p className="text-[10px] text-muted/70 mt-1">© {new Date().getFullYear()} Saltern Studio · GlobProxy</p>
        </div>
      </div>
    </div>
  )
}
