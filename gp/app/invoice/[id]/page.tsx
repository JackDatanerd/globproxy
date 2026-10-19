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
  // isProtected) for the not-logged-in and MFA-step-up (for accounts that
  // enabled 2FA) cases, the same way dashboard/layout.tsx re-checks
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
    .select('full_name, company_name, email, billing_address, tax_id')
    .eq('id', user.id)
    .single()

  // Credit notes for any refunds (RLS: customers read refund rows of their own
  // orders only). A failed read just omits the lines rather than breaking the
  // invoice.
  const { data: refunds } = await supabase
    .from('order_refunds')
    .select('credit_note_number, amount_usd, created_at')
    .eq('order_id', order.id)
    .order('created_at', { ascending: true })

  // Seller identity — set INVOICE_SELLER_ADDRESS / INVOICE_SELLER_TAX_ID in the
  // environment to print the legal address and registration number. Lines that
  // aren't configured are omitted rather than printed blank.
  const sellerName = process.env.INVOICE_SELLER_NAME?.trim() || 'Saltern Studio'
  const sellerAddress = process.env.INVOICE_SELLER_ADDRESS?.trim() || ''
  const sellerTaxId = process.env.INVOICE_SELLER_TAX_ID?.trim() || ''

  // Buyer details as they were when the order was paid (frozen by
  // claim_and_credit_order); invoices issued before that fall back to the
  // current profile.
  const snap = (order.billing_details ?? null) as { name?: string; contact?: string; email?: string; address?: string; tax_id?: string } | null
  const buyer = snap ?? {
    name: profile?.company_name || profile?.full_name || undefined,
    contact: profile?.company_name ? profile?.full_name ?? undefined : undefined,
    email: profile?.email,
    address: profile?.billing_address ?? undefined,
    tax_id: profile?.tax_id ?? undefined,
  }

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

  // Refunded before it was ever credited: money came back, but no invoice
  // number was issued (they are assigned when the order is claimed as paid).
  if (!order.bandwidth_credited && !order.invoice_number) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center p-6">
        <div className="text-center max-w-sm">
          <p className="text-ink font-display font-semibold text-lg mb-1.5">No invoice for this order</p>
          <p className="text-muted text-sm mb-5">
            This order was refunded before it was completed, so no invoice was issued.
            {(refunds ?? []).length > 0 && <> Credit note: <span className="font-mono">{refunds![0].credit_note_number}</span>.</>}
          </p>
          <Link href="/dashboard/billing" className="text-accent text-sm hover:underline">← Back to Billing</Link>
        </div>
      </div>
    )
  }

  const isRefunded = order.payment_status === 'refunded'
  const refundedTotal = Number(order.refunded_usd ?? 0)
  const isPartlyRefunded = !isRefunded && refundedTotal > 0
  const billedName = buyer.name || buyer.email || 'Customer'

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
            <div className="text-sm text-ink font-medium">{sellerName}</div>
            <div className="text-sm text-ink2">trading as GlobProxy</div>
            {sellerAddress && <div className="text-sm text-ink2 whitespace-pre-line">{sellerAddress}</div>}
            {sellerTaxId && <div className="text-sm text-ink2">Tax ID: {sellerTaxId}</div>}
            <div className="text-sm text-ink2">support@globproxy.com</div>
          </div>
          <div>
            <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-1.5">Billed to</div>
            <div className="text-sm text-ink font-medium">{billedName}</div>
            {buyer.contact && buyer.contact !== billedName && <div className="text-sm text-ink2">{buyer.contact}</div>}
            {buyer.address && <div className="text-sm text-ink2 whitespace-pre-line">{buyer.address}</div>}
            {buyer.tax_id && <div className="text-sm text-ink2">Tax ID: {buyer.tax_id}</div>}
            <div className="text-sm text-ink2">{buyer.email}</div>
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
              {isRefunded ? 'Refunded' : isPartlyRefunded ? 'Paid · partly refunded' : 'Paid'}
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
            {(refunds ?? []).length > 0 ? (
              <>
                {refunds!.map(r => (
                  <tr key={r.credit_note_number}>
                    <td className="pt-2 text-sm text-red-500 text-right">
                      Refund · credit note {r.credit_note_number} ({formatDate(r.created_at)})
                    </td>
                    <td className="pt-2 text-sm text-red-500 text-right font-mono">−${Number(r.amount_usd).toFixed(2)}</td>
                  </tr>
                ))}
                <tr>
                  <td className="pt-3 text-sm font-semibold text-ink text-right">Net paid (USD)</td>
                  <td className="pt-3 text-sm font-semibold text-ink text-right font-mono">${Math.max(Number(order.amount_usd) - refundedTotal, 0).toFixed(2)}</td>
                </tr>
              </>
            ) : refundedTotal > 0 && (
              <tr>
                <td className="pt-2 text-sm text-red-500 text-right">Refunded{order.refunded_at ? ` (${formatDate(order.refunded_at)})` : ''}</td>
                <td className="pt-2 text-sm text-red-500 text-right font-mono">−${refundedTotal.toFixed(2)}</td>
              </tr>
            )}
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
