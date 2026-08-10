'use client'
import Link from 'next/link'

// Split out from the invoice page (a Server Component, so it can do the
// ownership check + data fetch server-side) purely because window.print()
// needs a client boundary. "Download PDF" is deliberately the browser's
// own print-to-PDF rather than a server-generated file: this app deploys
// to Cloudflare Workers (see wrangler.jsonc), where a Node PDF library is
// a real compatibility risk even with nodejs_compat — the browser already
// has a reliable, zero-dependency PDF renderer built in, and every major
// browser's print dialog defaults to "Save as PDF" for a printable page
// like this one.
export default function InvoiceActions() {
  return (
    <div className="print:hidden flex items-center justify-between mb-6 max-w-2xl mx-auto">
      <Link href="/dashboard/billing" className="text-sm text-muted hover:text-ink transition-colors">
        ← Back to Billing
      </Link>
      <button
        onClick={() => window.print()}
        className="bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-medium shadow-[0_2px_8px_rgba(0,87,255,.2)] hover:-translate-y-0.5 transition-all"
      >
        Download PDF
      </button>
    </div>
  )
}
