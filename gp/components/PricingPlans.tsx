import Link from 'next/link'

const plans = [
  { name:'Micro',   tagline:'For testing & pay-as-you-go', gb:1,   price:4.50, total:4.50,  badge:'pay-as-you-go', features:['1 GB non-expiring bandwidth','195 countries','Rotating & sticky sessions','Dashboard access','Email support'], featured:false },
  { name:'Starter', tagline:'For testing & small projects', gb:10,  price:3.50, total:35,    features:['10 GB non-expiring bandwidth','195 countries','Rotating & sticky sessions','Dashboard access','Email support'], featured:false },
  { name:'Growth',  tagline:'For agencies & power users',   gb:100, price:2.80, total:280,   savings:'Save 20%', features:['100 GB non-expiring bandwidth','City-level targeting','Full API access (resellers)','Sub-user management','Priority support'], featured:true },
  { name:'Scale',   tagline:'High-volume operations',       gb:500, price:2.00, total:1000,  savings:'Save 43%', features:['500 GB+ non-expiring bandwidth','Custom geo allocation','Dedicated account manager','White-label credentials','24/7 priority support'], featured:false },
]

export default function PricingPlans({ buyHref = '/auth/signup' }: { buyHref?: string }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
      {plans.map(p => (
        <div key={p.name} className={`bg-white rounded-2xl p-8 relative transition-all hover:-translate-y-0.5 ${p.featured ? 'border-2 border-accent shadow-[0_0_0_4px_rgba(0,87,255,.07)]' : 'border border-border hover:shadow-lg'}`}>
          {p.featured && <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 bg-accent text-white text-[10px] font-mono tracking-widest px-3 py-1 rounded-full">MOST POPULAR</div>}
          <div className="font-display font-bold text-xl text-ink mb-1">{p.name}</div>
          <div className="text-sm text-muted font-light mb-5">{p.tagline}</div>
          <div className="mb-1">
            <span className="font-display text-5xl font-bold text-ink tracking-tight">${p.price.toFixed(2)}</span>
            <span className="text-muted text-base">/GB</span>
          </div>
          <div className="text-xs font-mono text-muted mb-3">{p.gb} GB · ${p.total.toLocaleString()} total</div>
          {'savings' in p && p.savings && <div className="inline-block bg-accent2-light text-accent2 text-xs font-mono px-3 py-1 rounded-full mb-5">{p.savings}</div>}
          {'badge' in p && p.badge && <div className="inline-block bg-accent-light text-accent text-xs font-mono px-3 py-1 rounded-full mb-5">{p.badge}</div>}
          <div className="h-px bg-border my-5" />
          <ul className="flex flex-col gap-2.5 mb-7">
            {p.features.map(f => (
              <li key={f} className="flex items-start gap-2.5 text-sm text-ink2 font-light">
                <span className="text-accent2 font-bold flex-shrink-0 mt-0.5">✓</span>{f}
              </li>
            ))}
          </ul>
          <Link
            href={p.name === 'Scale' ? 'mailto:sales@globproxy.com' : buyHref}
            className={`block w-full text-center py-3 rounded-xl text-sm font-medium transition-all ${p.featured ? 'bg-accent text-white hover:opacity-90' : 'border border-border text-ink2 hover:border-accent hover:text-accent'}`}>
            {p.name === 'Scale' ? 'Contact us →' : 'Get started →'}
          </Link>
        </div>
      ))}
    </div>
  )
}