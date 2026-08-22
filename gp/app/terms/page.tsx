import Navbar from '@/components/Navbar'
import Link from 'next/link'

export const metadata = { title: 'Terms of Service — GlobProxy' }

export default function TermsPage() {
  return (
    <>
      <Navbar />
      <div className="max-w-3xl mx-auto px-6 py-16">
        <div className="mb-10">
          <div className="inline-block bg-accent-light text-accent text-xs font-mono tracking-widest uppercase px-4 py-1.5 rounded-full mb-4">Legal</div>
          <h1 className="font-display font-bold text-4xl text-ink tracking-tight mb-3">Terms of Service</h1>
          <p className="text-muted text-sm font-mono">Last updated: April 2026 · Effective upon account creation</p>
        </div>
        <div className="bg-amber-50 border border-amber-100 rounded-xl p-5 mb-10">
          <p className="text-sm text-amber-800 font-medium mb-1">Please read carefully</p>
          <p className="text-sm text-amber-700 font-light">By creating a GlobProxy account or purchasing bandwidth, you agree to these terms in full.</p>
        </div>
        <div className="space-y-8 text-ink2 leading-relaxed">
          <section>
            <h2 className="font-display font-bold text-xl text-ink mb-3">1. The Service</h2>
            <p className="text-sm">GlobProxy (operated by Saltern Studio) provides access to a network of residential IP addresses on a prepaid basis. Bandwidth does not expire. We act as a reseller of proxy infrastructure provided by third-party suppliers.</p>
          </section>
          <section>
            <h2 className="font-display font-bold text-xl text-ink mb-3">2. Acceptable Use</h2>
            <p className="text-sm mb-3">GlobProxy may only be used for lawful purposes. You agree not to use our bandwidth for:</p>
            <div className="bg-red-50 border border-red-100 rounded-xl p-5">
              <ul className="space-y-2 text-sm text-red-800">
                {['Any activity that violates applicable law','Unauthorized access to computer systems or data','DDoS or network attacks of any kind','Sending unsolicited bulk email (spam)','Fraud, identity theft, or financial crime','Distribution of illegal content including CSAM','Bypassing international sanctions or export controls'].map(i=>(
                  <li key={i} className="flex items-start gap-2"><span className="font-bold flex-shrink-0">✗</span>{i}</li>
                ))}
              </ul>
            </div>
            <p className="text-sm mt-3">Violations result in immediate account suspension without refund and may be reported to authorities.</p>
          </section>
          <section>
            <h2 className="font-display font-bold text-xl text-ink mb-3">3. Accounts</h2>
            <p className="text-sm">You must provide accurate information when registering. One account per person or entity. You are responsible for all activity under your account. Accounts using disposable or temporary email addresses are not permitted and will be removed.</p>
          </section>
          <section>
            <h2 className="font-display font-bold text-xl text-ink mb-3">4. Bandwidth and Pricing</h2>
            <p className="text-sm">All purchases are prepaid. Bandwidth does not expire and remains in your account until consumed. We may change pricing for future purchases with 7 days notice. Existing purchased bandwidth is unaffected by price changes.</p>
          </section>
          <section>
            <h2 className="font-display font-bold text-xl text-ink mb-3">5. Resellers</h2>
            <p className="text-sm">Approved resellers may distribute GlobProxy bandwidth to clients under their own brand. Resellers are fully responsible for ensuring their clients comply with this Acceptable Use Policy. API access is granted by GlobProxy and may be revoked at any time for cause.</p>
          </section>
          <section>
            <h2 className="font-display font-bold text-xl text-ink mb-3">6. Limitation of Liability</h2>
            <p className="text-sm">GlobProxy is provided &quot;as is&quot;. To the fullest extent permitted by law, Saltern Studio shall not be liable for indirect, incidental, or consequential damages. Our total liability shall not exceed the amount paid by you in the 30 days preceding the claim.</p>
          </section>
          {/* <section>
            <h2 className="font-display font-bold text-xl text-ink mb-3">7. Governing Law</h2>
            <p className="text-sm">These terms are governed by the laws of Kenya. Disputes shall be subject to the jurisdiction of the courts of Nairobi, Kenya.</p>
          </section> */}
          <section>
            <h2 className="font-display font-bold text-xl text-ink mb-3">7. Contact</h2>
            <p className="text-sm">Questions: <a href="mailto:legal@globproxy.com" className="text-accent hover:underline">legal@globproxy.com</a></p>
          </section>
        </div>
        <div className="mt-12 pt-8 border-t border-border flex gap-6 text-sm">
          <Link href="/privacy" className="text-accent hover:underline">Privacy Policy</Link>
          <Link href="/refunds" className="text-accent hover:underline">Refund Policy</Link>
          <Link href="/" className="text-muted hover:text-ink">← Home</Link>
        </div>
      </div>
    </>
  )
}
