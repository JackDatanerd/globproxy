import Navbar from '@/components/Navbar'
import Link from 'next/link'

export const metadata = { title: 'Refund Policy — GlobProxy' }

export default function RefundsPage() {
  return (
    <>
      <Navbar />
      <div className="max-w-3xl mx-auto px-6 py-16">
        <div className="mb-10">
          <div className="inline-block bg-accent-light text-accent text-xs font-mono tracking-widest uppercase px-4 py-1.5 rounded-full mb-4">Legal</div>
          <h1 className="font-display font-bold text-4xl text-ink tracking-tight mb-3">Refund Policy</h1>
          <p className="text-muted text-sm font-mono">Last updated: October 2026</p>
        </div>
        <div className="space-y-8 text-ink2 leading-relaxed">
          <section>
            <h2 className="font-display font-bold text-xl text-ink mb-3">Our Commitment</h2>
            <p className="text-sm">Because our bandwidth never expires, you are never pressured to use it before losing it. This policy explains when refunds are available.</p>
          </section>
          <section>
            <h2 className="font-display font-bold text-xl text-ink mb-3">Eligible for Refund</h2>
            <div className="bg-accent2-light border border-accent2/20 rounded-xl p-5">
              <ul className="space-y-2 text-sm text-ink2">
                {['You purchased bandwidth, have used 0 GB, and request a refund within 72 hours of purchase.','A technical failure on our side prevented access and we cannot resolve it within 48 hours.','You were charged more than once for the same order due to a payment error.'].map(i=>(
                  <li key={i} className="flex items-start gap-2"><span className="text-accent2 font-bold flex-shrink-0">✓</span>{i}</li>
                ))}
              </ul>
            </div>
          </section>
          <section>
            <h2 className="font-display font-bold text-xl text-ink mb-3">Not Eligible for Refund</h2>
            <div className="bg-red-50 border border-red-100 rounded-xl p-5">
              <ul className="space-y-2 text-sm text-red-800">
                {['Any bandwidth that has been partially or fully consumed.','Purchases where more than 72 hours have passed since payment.','Accounts suspended due to Terms of Service violations.','Reseller bandwidth that has been allocated to sub-users.','Purchases made under a promotional or discounted rate.'].map(i=>(
                  <li key={i} className="flex items-start gap-2"><span className="font-bold flex-shrink-0">✗</span>{i}</li>
                ))}
              </ul>
            </div>
          </section>
          <section>
            <h2 className="font-display font-bold text-xl text-ink mb-3">How to Request a Refund</h2>
            <p className="text-sm mb-3">
              The quickest way is the <strong>Request refund</strong> button next to the order on your <Link href="/dashboard/billing" className="text-accent hover:underline">Billing</Link> page.
              It checks the 72-hour window and your usage for you and sends the request to our team. You can also email <a href="mailto:support@globproxy.com" className="text-accent hover:underline">support@globproxy.com</a> with:</p>
            <div className="bg-surface border border-border rounded-xl p-5">
              <ul className="space-y-2 text-sm">
                {['Your registered email address','Order ID (visible in your Billing page)','Reason for the refund request','Confirmation that no bandwidth has been used'].map(i=>(
                  <li key={i} className="flex items-center gap-2"><span className="text-accent font-mono text-xs">→</span>{i}</li>
                ))}
              </ul>
            </div>
            <p className="text-sm mt-3">We respond within 2 business days. Approved refunds are processed within 5–10 business days.</p>
            <p className="text-sm mt-3">
              Refunds go back to the way you paid: card payments to your card, M-Pesa payments to your M-Pesa in Kenya shillings at the rate that applied when you placed the order.
              A refund can be partial, and the bandwidth that corresponds to the refunded amount is taken back from your balance (we cannot take back bandwidth that is already allocated to a session).
              Every refund comes with a credit note against your invoice, shown on your Billing page.
            </p>
          </section>
          <section>
            <h2 className="font-display font-bold text-xl text-ink mb-3">Chargebacks</h2>
            <p className="text-sm">Please contact us before initiating a chargeback. Fraudulent chargebacks on legitimately delivered bandwidth will result in permanent account suspension.</p>
          </section>
        </div>
        <div className="mt-12 pt-8 border-t border-border flex gap-6 text-sm">
          <Link href="/privacy" className="text-accent hover:underline">Privacy Policy</Link>
          <Link href="/terms" className="text-accent hover:underline">Terms of Service</Link>
          <Link href="/" className="text-muted hover:text-ink">← Home</Link>
        </div>
      </div>
    </>
  )
}
