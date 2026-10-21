'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import toast from 'react-hot-toast'

// Split out from the invoice page (a Server Component, so it can do the
// ownership check + data fetch server-side) purely because window.print()
// needs a client boundary. "Download PDF" is deliberately the browser's
// own print-to-PDF rather than a server-generated file: this app deploys
// to Cloudflare Workers (see wrangler.jsonc), where a Node PDF library is
// a real compatibility risk even with nodejs_compat — the browser already
// has a reliable, zero-dependency PDF renderer built in, and every major
// browser's print dialog defaults to "Save as PDF" for a printable page
// like this one.
//
// `orderId` (invoices only) adds "Update billing details": it re-applies the
// customer's CURRENT details from Billing → Invoice details to this invoice.
export default function InvoiceActions({ orderId }: { orderId?: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function reissue() {
    if (!orderId || busy) return
    if (!confirm('Replace the billing address and tax ID on this invoice with the ones currently saved on your Billing page?')) return
    setBusy(true)
    try {
      const res = await fetch('/api/dashboard/billing/invoice-details', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: orderId }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) toast.error(d.error || 'Could not update the invoice')
      else if (d.unchanged) toast('Your saved billing details already match this invoice.', { icon: 'ℹ️' })
      else { toast.success('Invoice updated with your current billing details.'); router.refresh() }
    } catch {
      toast.error('Could not update the invoice')
    }
    setBusy(false)
  }

  return (
    <div className="print:hidden flex items-center justify-between mb-6 max-w-2xl mx-auto gap-3 flex-wrap">
      <Link href="/dashboard/billing" className="text-sm text-muted hover:text-ink transition-colors">
        ← Back to Billing
      </Link>
      <div className="flex items-center gap-3">
        {orderId && (
          <button
            onClick={reissue}
            disabled={busy}
            title="Apply the address / tax ID saved on your Billing page to this invoice"
            className="text-sm font-medium text-ink2 border border-border hover:border-accent hover:text-accent px-4 py-2.5 rounded-xl transition-colors disabled:opacity-60"
          >
            {busy ? 'Updating…' : 'Update billing details'}
          </button>
        )}
        <button
          onClick={() => window.print()}
          className="bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-medium shadow-[0_2px_8px_rgba(0,87,255,.2)] hover:-translate-y-0.5 transition-all"
        >
          Download PDF
        </button>
      </div>
    </div>
  )
}
