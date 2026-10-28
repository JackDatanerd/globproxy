import { REFERRAL_GB_BONUS, REFERRAL_MIN_ORDER_USD } from '@/lib/referrals'
import Link from 'next/link'
import Navbar from '@/components/Navbar'
import HeroCard from '@/components/HeroCard'
import PricingPlans from '@/components/PricingPlans'
import ResellerCalc from '@/components/ResellerCalc'
import { createClient } from '@/lib/supabase/server'
import { getPlan } from '@/lib/plans'

// "Start from $4.50" is the entry TOTAL (Micro: 1 GB @ $4.50), not a
// per-GB price — but sitting alone on a CTA button next to a reseller
// section that advertises $2.00/GB at Scale, it reads like a per-GB price
// floor that contradicts the lower number a few sections down. Pulling
// both from lib/plans.ts (the single source of truth already established
// there — see its own header comment) and pairing them in one line where
// the ambiguity would otherwise land removes the contradiction without
// touching the actual pricing.
const ENTRY_PLAN = getPlan('micro')!
const SCALE_PLAN = getPlan('scale')!

export default async function Home() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const buyHref = user ? '/dashboard/buy' : '/auth/signup'

  return (
    <>
      <Navbar />

      {/* HERO */}
      <section className="relative overflow-hidden pt-24 pb-20">
        <div className="absolute -top-48 -right-48 w-[600px] h-[600px] rounded-full bg-accent/5 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-24 -left-24 w-[400px] h-[400px] rounded-full bg-accent2/5 blur-3xl pointer-events-none" />
        <div className="max-w-6xl mx-auto px-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
            <div>
              <div className="inline-flex items-center gap-2 bg-accent-light text-accent text-xs font-mono tracking-widest uppercase px-4 py-1.5 rounded-full mb-6">
                <span className="w-1.5 h-1.5 rounded-full bg-accent2 animate-pulse" />
                35M+ IPs · 195 Countries · Never Expires
              </div>
              <h1 className="font-display text-5xl lg:text-6xl font-black leading-[1.05] tracking-tight text-ink mb-5">
                Proxies that never<br />expire. <em className="not-italic text-accent">Ever.</em>
              </h1>
              <p className="text-ink2 text-lg font-light leading-relaxed mb-8 max-w-lg">
                Buy residential bandwidth once. Use it across 195 countries at city-level precision — on your schedule, not ours. No monthly bills, no wasted GB.
              </p>
              <div className="flex gap-3 flex-wrap">
                <Link href={buyHref} className="inline-flex items-center gap-2 bg-accent text-white px-7 py-3.5 rounded-xl font-medium shadow-[0_2px_12px_rgba(0,87,255,.3)] hover:-translate-y-0.5 transition-all">Start from ${ENTRY_PLAN.total.toFixed(2)} →</Link>
                <Link href="#compare" className="inline-flex items-center gap-2 border border-border text-ink2 px-7 py-3.5 rounded-xl font-medium hover:border-ink2 transition-all">See comparison</Link>
              </div>
              <div className="flex items-center gap-3 mt-6 text-xs text-muted">
                <div className="flex gap-1">{[1,.6,.3].map((o,i)=><div key={i} className="w-2 h-2 rounded-full bg-accent2" style={{opacity:o}}/>)}</div>
                Trusted by 1,400+ freelancers and agencies worldwide
              </div>
              <p className="text-[11px] text-muted mt-2 font-mono">
                ${ENTRY_PLAN.total.toFixed(2)} total to get started · as low as ${SCALE_PLAN.price.toFixed(2)}/GB at scale
              </p>
            </div>
            <HeroCard />
          </div>
        </div>
      </section>

      {/* STATS */}
      <div className="bg-surface border-y border-border">
        <div className="max-w-6xl mx-auto px-6 py-10">
          <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-border">
            {[['35M+','Residential IPs'],['195','Countries'],['99.9%','Uptime'],['∞','No expiry']].map(([n,l])=>(
              <div key={l} className="text-center px-6">
                <div className="font-display text-4xl font-bold text-ink tracking-tight">{n}</div>
                <div className="text-xs text-muted uppercase tracking-widest font-mono mt-1">{l}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* TRUST — we publish what we can prove, not what sounds good */}
      <section className="py-20">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-12">
            <div className="inline-block bg-accent-light text-accent text-xs font-mono tracking-widest uppercase px-4 py-1.5 rounded-full mb-4">Clean by default</div>
            <h2 className="font-display text-4xl font-bold tracking-tight text-ink mb-3">We don&apos;t just say clean.<br />We publish it.</h2>
            <p className="text-ink2 font-light max-w-xl mx-auto leading-relaxed">No inflated claims — just what our own test runs actually find, updated regularly and open for anyone to check.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 max-w-3xl mx-auto">
            <Link href="/status" className="block border border-border rounded-xl p-7 hover:border-accent hover:shadow-sm transition-all bg-white">
              <div className="w-10 h-10 rounded-xl bg-accent-light flex items-center justify-center text-accent font-mono text-xs font-medium mb-5">✓</div>
              <h3 className="font-display font-bold text-lg text-ink mb-2">Live network status</h3>
              <p className="text-ink2 text-sm font-light leading-relaxed">Success rate and latency, tested on our own pool and published openly — not a marketing number. See current results →</p>
            </Link>
            <div className="border border-border rounded-xl p-7 bg-white">
              <div className="w-10 h-10 rounded-xl bg-accent-light flex items-center justify-center text-accent font-mono text-xs font-medium mb-5">ID</div>
              <h3 className="font-display font-bold text-lg text-ink mb-2">No ID verification</h3>
              <p className="text-ink2 text-sm font-light leading-relaxed">Sign up with an email and start using proxies in minutes — no identity documents required to get going.</p>
            </div>
          </div>
        </div>
      </section>

      {/* FEATURES */}
      <section id="features" className="py-24">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-14">
            <div className="inline-block bg-accent-light text-accent text-xs font-mono tracking-widest uppercase px-4 py-1.5 rounded-full mb-4">Built different</div>
            <h2 className="font-display text-4xl font-bold tracking-tight text-ink mb-3">Everything you need.<br />Nothing you don&apos;t.</h2>
            <p className="text-ink2 font-light max-w-xl mx-auto leading-relaxed">For freelancers, marketers, and multi-platform operators who need reliability without complexity.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {[
              {icon:'GEO',title:'City-level targeting',desc:'Appear local in any city across 195 countries. Switch geo on the fly — no reconnection needed.'},
              {icon:'ROT',title:'Rotating & sticky sessions',desc:'Fresh IP every request for automation, or hold a consistent identity for account management.'},
              {icon:'API',title:'Full API access',desc:'Automate everything. Sub-user creation, bandwidth allocation, and usage tracking via clean REST API.'},
              {icon:'∞',title:'Bandwidth never expires',desc:'Your GB balance stays on your account indefinitely. Buy when it suits you, use when you need it.'},
              {icon:'WL',title:'White-label ready',desc:"Sub-user credentials show only your brand. Fully invisible infrastructure — clients never see us."},
              {icon:'PAY',title:'Paystack payments',desc:'Card and mobile money via Paystack. Pay the way that works for you — no contracts, no minimums.'},
            ].map(f=>(
              <div key={f.title} className="border border-border rounded-xl p-7 hover:border-accent hover:shadow-sm transition-all bg-white">
                <div className="w-10 h-10 rounded-xl bg-accent-light flex items-center justify-center text-accent font-mono text-xs font-medium mb-5">{f.icon}</div>
                <h3 className="font-display font-bold text-lg text-ink mb-2">{f.title}</h3>
                <p className="text-ink2 text-sm font-light leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* COMPARE */}
      <section id="compare" className="py-12 pb-24">
        <div className="max-w-6xl mx-auto px-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-20 items-center">
            <div>
              <div className="inline-block bg-accent-light text-accent text-xs font-mono tracking-widest uppercase px-4 py-1.5 rounded-full mb-5">Honest comparison</div>
              <h2 className="font-display text-4xl font-bold tracking-tight text-ink leading-tight mb-4">Why operators are switching to GlobProxy</h2>
              <p className="text-ink2 font-light leading-relaxed mb-8">Most providers lock you into monthly subscriptions where unused bandwidth disappears. We built GlobProxy differently — your GB is yours, forever.</p>
              <div className="flex flex-col gap-3">
                {[
                  {icon:'$',title:'Up to 45% cheaper than competitors',sub:'Same residential quality, dramatically lower price at every volume tier'},
                  {icon:'∞',title:'No expiry, ever',sub:"Competitors expire unused bandwidth monthly. Yours stays until every byte is used"},
                  {icon:'→',title:'No subscription traps',sub:'Buy what you need, stop when you want. No recurring charges or cancellation windows'},
                ].map(p=>(
                  <div key={p.title} className="flex gap-3 items-start p-4 bg-surface border border-border rounded-xl">
                    <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center text-white font-mono text-xs flex-shrink-0">{p.icon}</div>
                    <div><div className="font-medium text-sm text-ink">{p.title}</div><div className="text-xs text-muted mt-0.5 font-light">{p.sub}</div></div>
                  </div>
                ))}
              </div>
            </div>
            <div className="border border-border rounded-2xl overflow-hidden shadow-lg">
              <div className="grid grid-cols-3 bg-surface border-b border-border">
                <div className="px-5 py-3 text-xs font-mono text-muted tracking-wider uppercase">Feature</div>
                <div className="px-5 py-3 text-xs font-mono text-accent tracking-wider uppercase bg-accent-light text-center">GlobProxy</div>
                <div className="px-5 py-3 text-xs font-mono text-muted tracking-wider uppercase text-center">Others</div>
              </div>
              {[
                ['Bandwidth expiry','Never ✓','Monthly ✗'],
                ['Subscriptions','None ✓','Required ✗'],
                ['195 countries','✓','100–195'],
                ['City targeting','✓','Varies'],
                ['White-label API','✓','Extra cost'],
                ['100 GB price','$2.80/GB','$6.40+/GB'],
              ].map((r,i)=>(
                <div key={i} className="grid grid-cols-3 border-b border-border last:border-none">
                  <div className="px-5 py-3.5 text-xs font-mono text-muted">{r[0]}</div>
                  <div className="px-5 py-3.5 text-sm text-ink font-medium bg-accent/[.02] text-center">{r[1]}</div>
                  <div className="px-5 py-3.5 text-sm text-muted text-center">{r[2]}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* PRICING */}
      <section id="pricing" className="py-24 bg-surface">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-14">
            <div className="inline-block bg-accent-light text-accent text-xs font-mono tracking-widest uppercase px-4 py-1.5 rounded-full mb-4">Pricing</div>
            <h2 className="font-display text-4xl font-bold tracking-tight text-ink mb-3">Simple. Transparent.<br />Yours to keep.</h2>
            <p className="text-ink2 font-light max-w-lg mx-auto leading-relaxed">No subscriptions. No monthly bills. Every GB stays on your account indefinitely.</p>
          </div>
          <PricingPlans buyHref={buyHref} />
          <p className="text-center text-xs font-mono text-muted mt-6">All plans include non-expiring bandwidth · No hidden fees · No contracts</p>
        </div>
      </section>

      {/* RESELLER */}
      <section id="reseller" className="py-24">
        <div className="max-w-6xl mx-auto px-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-20 items-center">
            <div>
              <div className="inline-block bg-accent2-light text-accent2 text-xs font-mono tracking-widest uppercase px-4 py-1.5 rounded-full mb-5">Reseller Program</div>
              <h2 className="font-display text-4xl font-bold tracking-tight text-ink leading-tight mb-4">Resell GlobProxy.<br />Keep the difference.</h2>
              <p className="text-ink2 font-light leading-relaxed mb-7">Buy wholesale bandwidth and resell at your own price under your own brand. Our white-label API handles credentials, sub-users, and usage tracking — invisibly.</p>
              <div className="flex flex-col gap-2.5 mb-8">
                {['Bandwidth never expires — sell at your own pace, no pressure','Full white-label API — your brand, your pricing, your clients','No minimum commitment to join the program','Credentials activate only when your client\'s payment is confirmed','Dedicated account manager as you scale'].map(p=>(
                  <div key={p} className="flex items-start gap-3 text-sm text-ink2 font-light">
                    <span className="text-accent font-bold flex-shrink-0 mt-0.5">→</span>{p}
                  </div>
                ))}
              </div>
              <Link href="/auth/signup?role=reseller" className="inline-flex items-center gap-2 bg-ink text-white px-7 py-3.5 rounded-xl font-medium hover:-translate-y-0.5 transition-all">Apply to resell →</Link>
              <div className="mt-3">
                <Link href="/docs/api" className="text-sm text-accent2 hover:underline">
                  API access is available to approved resellers — view the docs →
                </Link>
              </div>
            </div>
            <ResellerCalc />
          </div>
        </div>
      </section>

      {/* AFFILIATES */}
      <section id="affiliates" className="py-24 bg-surface">
        <div className="max-w-6xl mx-auto px-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-20 items-center">
            <div>
              <div className="inline-block bg-accent-light text-accent text-xs font-mono tracking-widest uppercase px-4 py-1.5 rounded-full mb-5">Refer & Earn</div>
              <h2 className="font-display text-4xl font-bold tracking-tight text-ink leading-tight mb-4">Share GlobProxy.<br />Get paid for it.</h2>
              <p className="text-ink2 font-light leading-relaxed mb-7">Every account gets a free referral link — refer someone and you both get {REFERRAL_GB_BONUS}GB free after their first purchase of ${REFERRAL_MIN_ORDER_USD}+. Run a blog, a forum presence, or a community that needs proxies? Apply for the affiliate program and earn cash instead.</p>
              <div className="flex flex-col gap-2.5 mb-8">
                {[`Free referral link, no approval needed — ${REFERRAL_GB_BONUS}GB bonus for both sides`,'Approved affiliates earn 30% commission for a referral\'s first 90 days','15% commission on all their later orders, with no cap','Paid twice a month by USDT, M-Pesa or bank transfer'].map(p=>(
                  <div key={p} className="flex items-start gap-3 text-sm text-ink2 font-light">
                    <span className="text-accent font-bold flex-shrink-0 mt-0.5">→</span>{p}
                  </div>
                ))}
              </div>
              <Link href="/auth/signup" className="inline-flex items-center gap-2 bg-ink text-white px-7 py-3.5 rounded-xl font-medium hover:-translate-y-0.5 transition-all">Get your referral link →</Link>
            </div>
            <div className="border border-border rounded-2xl overflow-hidden shadow-lg bg-white">
              <div className="px-6 py-4 border-b border-border bg-ink text-white">
                <div className="text-xs font-mono uppercase tracking-widest text-white/60">How it pays out</div>
              </div>
              <div className="flex flex-col divide-y divide-border">
                {[
                  ['Anyone you refer', '1GB credit, both sides, on their first order'],
                  ['Approved affiliates', '30% intro → 15% lifetime commission, per order'],
                  ['Payout schedule', 'Biweekly — earn 1st–15th, paid by the 20th; earn 16th–end, paid by the 5th'],
                ].map(([label, val]) => (
                  <div key={label} className="px-6 py-4">
                    <div className="text-xs font-mono text-muted uppercase tracking-wider mb-1">{label}</div>
                    <div className="text-sm text-ink">{val}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24 bg-ink relative overflow-hidden">
        <div className="absolute -top-48 -right-24 w-[500px] h-[500px] rounded-full bg-accent/10 blur-3xl" />
        <div className="absolute -bottom-36 -left-24 w-[400px] h-[400px] rounded-full bg-accent2/8 blur-3xl" />
        <div className="max-w-6xl mx-auto px-6 text-center relative z-10">
          <h2 className="font-display text-5xl font-black text-white tracking-tight leading-tight mb-4">Your bandwidth.<br />Your pace. <em className="not-italic text-accent2/80">Forever.</em></h2>
          <p className="text-white/40 font-light mb-10">Join 1,400+ operators who stopped paying for bandwidth they don&apos;t use.</p>
          <div className="flex gap-3 justify-center flex-wrap">
            <Link href={buyHref} className="inline-flex items-center gap-2 bg-white text-ink px-7 py-3.5 rounded-xl font-medium hover:-translate-y-0.5 transition-all">Start from ${ENTRY_PLAN.total.toFixed(2)} →</Link>
            <Link href="#reseller" className="inline-flex items-center gap-2 border border-white/20 text-white px-7 py-3.5 rounded-xl font-medium hover:border-white/50 transition-all">Become a reseller</Link>
          </div>
          <p className="text-[11px] text-white/30 mt-4 font-mono">
            ${ENTRY_PLAN.total.toFixed(2)} total to get started · as low as ${SCALE_PLAN.price.toFixed(2)}/GB at scale
          </p>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="bg-ink border-t border-white/5 pt-14 pb-8">
        <div className="max-w-6xl mx-auto px-6">
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-10 mb-12">
            <div className="col-span-2 lg:col-span-1">
              <div className="font-display font-black text-2xl text-white mb-3">Glob<span className="text-accent">Proxy</span></div>
              <p className="text-white/30 text-sm font-light leading-relaxed max-w-xs">Residential proxies that never expire. Buy once, use forever. No subscriptions.</p>
            </div>
            {[
              {title:'Product',links:[['/#features','Features'],['/#pricing','Pricing'],['/#reseller','Resellers'],['/#compare','Compare'],['/docs/api','API Docs']]},
              {title:'Resources',links:[['/blog','Blog'],['/help','Help centre'],['/locations','Locations'],['/status','Network status']]},
              {title:'Support',links:[['mailto:support@globproxy.com','Contact us'],['mailto:sales@globproxy.com','Sales']]},
              {title:'Legal',links:[['/terms','Terms of Service'],['/privacy','Privacy Policy'],['/refunds','Refund Policy']]},
            ].map(col=>(
              <div key={col.title}>
                <div className="text-white/30 text-xs font-mono tracking-widest uppercase mb-4">{col.title}</div>
                {col.links.map(([h,l])=><a key={h} href={h} className="block text-white/50 text-sm mb-2.5 hover:text-white/80 transition-colors">{l}</a>)}
              </div>
            ))}
          </div>
          <div className="border-t border-white/5 pt-6 flex justify-between items-center">
            <p className="text-white/25 text-xs">© {new Date().getFullYear()} GlobProxy · Saltern Studio. All rights reserved.</p>
            <p className="text-white/25 text-xs font-mono">globproxy.com</p>
          </div>
        </div>
      </footer>
    </>
  )
}