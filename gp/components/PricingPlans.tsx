import Link from 'next/link'
import { PLANS as plans } from '@/lib/plans'
import { formatUsd } from '@/lib/format'

export default function PricingPlans({ buyHref = '/auth/signup' }: { buyHref?: string }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
      {plans.map(p => (
        <div key={p.name} className={`bg-white rounded-2xl p-8 relative transition-all hover:-translate-y-0.5 ${p.featured ? 'border-2 border-accent shadow-[0_0_0_4px_rgba(0,87,255,.07)]' : 'border border-border hover:shadow-lg'}`}>
          {p.featured && <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 bg-accent text-white text-[10px] font-mono tracking-widest px-3 py-1 rounded-full">MOST POPULAR</div>}
          <div className="font-display font-bold text-xl text-ink mb-1">{p.name}</div>
          <div className="text-sm text-muted font-light mb-5">{p.tagline}</div>
          <div className="mb-1">
            <span className="font-display text-5xl font-bold text-ink tracking-tight">{formatUsd(p.price)}</span>
            <span className="text-muted text-base">/GB</span>
          </div>
          <div className="text-xs font-mono text-muted mb-3">{p.gb} GB · {formatUsd(p.total)} total</div>
          {'savings' in p && p.savings && <div className="inline-block bg-accent2-light text-accent2 text-xs font-mono px-3 py-1 rounded-full mb-5">{p.savings}</div>}
          {'badge' in p && p.badge && <div className="inline-block bg-accent-light text-accent text-xs font-mono px-3 py-1 rounded-full mb-5">{p.badge}</div>}
          <div className="h-px bg-border my-5" />
          <ul className="flex flex-col gap-2.5 mb-7">
            {(p.features ?? []).map(f => (
              <li key={f} className="flex items-start gap-2.5 text-sm text-ink2 font-light">
                <span className="text-accent2 font-bold flex-shrink-0 mt-0.5">✓</span>{f}
              </li>
            ))}
          </ul>
          <Link
            href={p.custom ? 'mailto:sales@globproxy.com' : buyHref}
            className={`block w-full text-center py-3 rounded-xl text-sm font-medium transition-all ${p.featured ? 'bg-accent text-white hover:opacity-90' : 'border border-border text-ink2 hover:border-accent hover:text-accent'}`}>
            {p.custom ? 'Contact us →' : 'Get started →'}
          </Link>
        </div>
      ))}
    </div>
  )
}