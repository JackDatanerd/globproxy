import Navbar from '@/components/Navbar'
import Link from 'next/link'

export const metadata = { title: 'Privacy Policy — GlobProxy' }

export default function PrivacyPage() {
  return (
    <>
      <Navbar />
      <div className="max-w-3xl mx-auto px-6 py-16">
        <div className="mb-10">
          <div className="inline-block bg-accent-light text-accent text-xs font-mono tracking-widest uppercase px-4 py-1.5 rounded-full mb-4">Legal</div>
          <h1 className="font-display font-bold text-4xl text-ink tracking-tight mb-3">Privacy Policy</h1>
          <p className="text-muted text-sm font-mono">Last updated: April 2026</p>
        </div>
        <div className="space-y-8 text-ink2 leading-relaxed">
          <section>
            <h2 className="font-display font-bold text-xl text-ink mb-3">1. Who We Are</h2>
            <p className="text-sm">GlobProxy is operated by Saltern Studio. We provide residential proxy bandwidth services. Contact: <a href="mailto:privacy@globproxy.com" className="text-accent hover:underline">privacy@globproxy.com</a></p>
          </section>
          <section>
            <h2 className="font-display font-bold text-xl text-ink mb-3">2. What Data We Collect</h2>
            <div className="bg-surface border border-border rounded-xl p-5 space-y-3">
              {[['Account data','Full name, email address, and hashed password.'],['Payment data','Transaction amounts and Paystack reference IDs. We never store card numbers — handled by Paystack under PCI-DSS.'],['Usage data','Bandwidth consumed per session and geo-targeting preferences you configure.'],['Technical data','IP address at login, browser type, and session tokens for security only.'],['Affiliate & payout data','If you apply to the affiliate program or add a payout method: your application answers, and your payout destination (USDT wallet address, M-Pesa number, or bank details). For referrals, a one-way hash of the signup IP address is kept to detect duplicate or self-referred accounts, and referral clicks are counted per day without identifying the visitor.']].map(([t,d])=>(
                <div key={t}>
                  <div className="font-medium text-ink text-sm mb-1">{t}</div>
                  <div className="text-sm text-muted">{d}</div>
                  <div className="h-px bg-border mt-3 last:hidden" />
                </div>
              ))}
            </div>
          </section>
          <section>
            <h2 className="font-display font-bold text-xl text-ink mb-3">3. How We Use Your Data</h2>
            <ul className="space-y-2 text-sm">
              {['To create and manage your account','To process payments and credit bandwidth','To provision proxy credentials through our infrastructure partner','To send transactional emails — receipts, activation confirmations, usage alerts','To detect and prevent fraud and abuse','To comply with legal obligations'].map(i=>(
                <li key={i} className="flex items-start gap-2"><span className="text-accent2 font-bold flex-shrink-0">→</span>{i}</li>
              ))}
            </ul>
            <p className="mt-4 text-sm font-medium">We do not sell your data. We do not use your data for advertising. Ever.</p>
          </section>
          <section>
            <h2 className="font-display font-bold text-xl text-ink mb-3">4. Third-Party Services</h2>
            <div className="bg-surface border border-border rounded-xl overflow-hidden">
              {[['Supabase','Database and authentication','EU (Frankfurt)'],['Cloudflare','Hosting and edge network','Global'],['Paystack','Payment processing','Global'],['Proxy Network Partner','Proxy infrastructure','Global'],['Resend','Transactional email','US']].map(([n,r,l],i,arr)=>(
                <div key={n} className={`grid grid-cols-3 px-5 py-3 text-sm ${i<arr.length-1?'border-b border-border':''}`}>
                  <span className="font-medium text-ink">{n}</span>
                  <span className="text-muted">{r}</span>
                  <span className="text-muted font-mono text-xs">{l}</span>
                </div>
              ))}
            </div>
          </section>
          <section>
            <h2 className="font-display font-bold text-xl text-ink mb-3">5. Data Retention</h2>
            <p className="text-sm">We retain account data while your account is active. On account closure, personal data is deleted within 30 days. Financial records are retained for 7 years. When an account is deleted, its payout destination and application answers are removed immediately; the payout records themselves (amounts, dates and the destination snapshot of payouts already created) are kept as financial records.</p>
          </section>
          <section>
            <h2 className="font-display font-bold text-xl text-ink mb-3">6. Your Rights</h2>
            <ul className="space-y-1.5 text-sm">
              {['Access the personal data we hold about you','Request correction of inaccurate data','Request deletion of your account and data','Object to processing of your data','Export your data in a portable format'].map(r=>(
                <li key={r} className="flex items-start gap-2"><span className="text-accent font-bold">✓</span>{r}</li>
              ))}
            </ul>
            <p className="mt-3 text-sm">Email <a href="mailto:privacy@globproxy.com" className="text-accent hover:underline">privacy@globproxy.com</a>. We respond within 14 days.</p>
          </section>
          <section>
            <h2 className="font-display font-bold text-xl text-ink mb-3">7. Cookies</h2>
            <p className="text-sm">We use essential cookies for authentication and security. If you arrive through a referral link we also set a first-party cookie for up to 60 days that remembers the referral code (and an optional campaign tag) so the referrer gets credit if you sign up. It is used for nothing else and is never shared. No advertising or third-party tracking cookies.</p>
          </section>
        </div>
        <div className="mt-12 pt-8 border-t border-border flex gap-6 text-sm">
          <Link href="/terms" className="text-accent hover:underline">Terms of Service</Link>
          <Link href="/refunds" className="text-accent hover:underline">Refund Policy</Link>
          <Link href="/" className="text-muted hover:text-ink">← Home</Link>
        </div>
      </div>
    </>
  )
}
