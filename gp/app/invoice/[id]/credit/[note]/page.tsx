import { createClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import InvoiceActions from '@/components/InvoiceActions'

// Private financial document — never indexed, never cached across users.
export const metadata = { title: 'Credit note — GlobProxy', robots: { index: false, follow: false } }

function formatDate(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

const NOTE_RE = /^CN-\d{4}-\d{6}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// A stand-alone, printable credit note for one refund — the document an
// accountant files against the original invoice. Ownership comes from RLS (own
// orders / own refund rows); the explicit user_id filter is defence in depth,
// same as the invoice page.
export default async function CreditNotePage({ params }: { params: Promise<{ id: string; note: string }> }) {
  const { id, note } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect(`/auth/login?next=/invoice/${id}/credit/${note}`)
  if (!UUID_RE.test(id) || !NOTE_RE.test(note)) notFound()

  const { data: order } = await supabase
    .from('orders')
    .select('id, invoice_number, billing_details, amount_usd, refunded_usd, paid_at, created_at, payment_method, pay_currency, pay_amount, is_canary')
    .eq('id', id)
    .eq('user_id', user.id)
    .single()
  if (!order) notFound()

  const { data: refund } = await supabase
    .from('order_refunds')
    .select('credit_note_number, amount_usd, created_at')
    .eq('order_id', order.id)
    .eq('credit_note_number', note)
    .maybeSingle()
  if (!refund) notFound()

  const { data: profile } = await supabase
    .from('profiles').select('full_name, company_name, email, billing_address, tax_id').eq('id', user.id).single()

  const sellerName = process.env.INVOICE_SELLER_NAME?.trim() || 'Saltern Studio'
  const sellerAddress = process.env.INVOICE_SELLER_ADDRESS?.trim() || ''
  const sellerTaxId = process.env.INVOICE_SELLER_TAX_ID?.trim() || ''

  // Same buyer block as the invoice it credits (frozen when it was paid).
  const snap = (order.billing_details ?? null) as { name?: string; contact?: string; email?: string; address?: string; tax_id?: string } | null
  const buyer = snap ?? {
    name: profile?.company_name || profile?.full_name || undefined,
    contact: profile?.company_name ? profile?.full_name ?? undefined : undefined,
    email: profile?.email,
    address: profile?.billing_address ?? undefined,
    tax_id: profile?.tax_id ?? undefined,
  }
  const billedName = buyer.name || buyer.email || 'Customer'
  const amount = Number(refund.amount_usd)
  const invoiceRef = order.invoice_number ?? `#${order.id.slice(0, 8)}`
  const paidMpesa = order.pay_currency && order.pay_currency !== 'USD' && order.pay_amount != null

  return (
    <div className="min-h-screen bg-surface py-10 px-6 print:bg-white print:py-0 print:px-0">
      <InvoiceActions />

      <div className="max-w-2xl mx-auto bg-white border border-border rounded-2xl print:border-0 print:rounded-none p-10 print:p-0">
        <div className="flex items-start justify-between mb-10">
          <div>
            <div className="font-display font-bold text-xl text-ink">GlobProxy</div>
            <div className="text-[11px] text-muted mt-0.5">Residential Proxies That Never Expire</div>
          </div>
          <div className="text-right">
            <div className="font-display font-bold text-lg text-ink">CREDIT NOTE</div>
            <div className="text-xs font-mono text-muted mt-1">{refund.credit_note_number}</div>
          </div>
        </div>

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
            <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-1.5">Credited to</div>
            <div className="text-sm text-ink font-medium">{billedName}</div>
            {buyer.contact && buyer.contact !== billedName && <div className="text-sm text-ink2">{buyer.contact}</div>}
            {buyer.address && <div className="text-sm text-ink2 whitespace-pre-line">{buyer.address}</div>}
            {buyer.tax_id && <div className="text-sm text-ink2">Tax ID: {buyer.tax_id}</div>}
            <div className="text-sm text-ink2">{buyer.email}</div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4 mb-8 text-sm">
          <div>
            <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-1">Credit note date</div>
            <div className="text-ink">{formatDate(refund.created_at)}</div>
          </div>
          <div>
            <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-1">Original invoice</div>
            <div className="text-ink font-mono text-xs">
              <Link href={`/invoice/${order.id}`} className="underline print:no-underline">{invoiceRef}</Link>
            </div>
          </div>
          <div>
            <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-1">Refunded to</div>
            <div className="text-ink">{order.payment_method === 'mpesa' ? 'M-Pesa' : 'Original payment method'}</div>
          </div>
        </div>

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
                Refund against invoice {invoiceRef} ({formatDate(order.paid_at ?? order.created_at)})
                <div className="text-xs text-muted mt-0.5">Bandwidth proportional to the refunded amount is removed from your balance.</div>
              </td>
              <td className="py-4 text-sm text-ink text-right font-mono">−${amount.toFixed(2)}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td className="pt-4 text-sm font-semibold text-ink text-right">Total credited (USD)</td>
              <td className="pt-4 text-sm font-semibold text-ink text-right font-mono">${amount.toFixed(2)}</td>
            </tr>
          </tfoot>
        </table>
        {paidMpesa && (
          <p className="text-xs text-muted mb-4">
            The original payment was made in {order.pay_currency}; the refund is returned in {order.pay_currency} at the rate that applied when the order was placed.
            The credit note total above is in USD.
          </p>
        )}

        <div className="border-t border-border pt-6 text-center">
          <p className="text-xs text-muted">Questions about this credit note? support@globproxy.com</p>
          <p className="text-[10px] text-muted/70 mt-1">© {new Date().getFullYear()} Saltern Studio · GlobProxy</p>
        </div>
      </div>
    </div>
  )
}
