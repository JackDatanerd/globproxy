import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import Navbar from '@/components/Navbar'
import Footer from '@/components/Footer'
import JsonLd from '@/components/JsonLd'
import { LOCATION_COUNTRIES } from '@/lib/locations/data'
import { locationIntro, locationUseCases } from '@/lib/locations/copy'
import { PLANS } from '@/lib/plans'
import { pageMetadata } from '@/lib/seo'

export function generateStaticParams() {
  return LOCATION_COUNTRIES.map((c) => ({ country: c.code }))
}

function getCountry(code: string) {
  return LOCATION_COUNTRIES.find((c) => c.code === code)
}

export async function generateMetadata({ params }: { params: Promise<{ country: string }> }): Promise<Metadata> {
  const { country: code } = await params
  const country = getCountry(code)
  if (!country) return {}

  const entry = PLANS.find((p) => !p.custom) ?? PLANS[0]
  const cities = `${country.cityCount.toLocaleString()} ${country.cityCount === 1 ? 'city' : 'cities'}`
  const networks = `${country.asnCount.toLocaleString()} ${country.asnCount === 1 ? 'network' : 'networks'}`
  return pageMetadata({
    title: `${country.name} Residential Proxies — City-Level Targeting — GlobProxy`,
    socialTitle: `${country.name} Residential Proxies — GlobProxy`,
    description: `Residential proxies in ${country.name}: ${cities}, ${networks}, non-expiring bandwidth from $${entry.total.toFixed(2)}.`,
    path: `/locations/${country.code}`,
  })
}

export default async function LocationCountryPage({ params }: { params: Promise<{ country: string }> }) {
  const { country: code } = await params
  const country = getCountry(code)
  if (!country) notFound()

  const url = `https://globproxy.com/locations/${country.code}`
  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://globproxy.com' },
      { '@type': 'ListItem', position: 2, name: 'Locations', item: 'https://globproxy.com/locations' },
      { '@type': 'ListItem', position: 3, name: country.name, item: url },
    ],
  }
  const serviceSchema = {
    '@context': 'https://schema.org',
    '@type': 'Service',
    serviceType: 'Residential Proxy Network',
    provider: { '@type': 'Organization', name: 'GlobProxy', url: 'https://globproxy.com' },
    areaServed: { '@type': 'Country', name: country.name },
    url,
  }

  const entry = PLANS.find((p) => !p.custom) ?? PLANS[0]

  return (
    <>
      <JsonLd data={breadcrumbSchema} />
      <JsonLd data={serviceSchema} />
      <Navbar />
      <main id="main" className="max-w-4xl mx-auto px-6 py-16">
        <nav aria-label="Breadcrumb" className="text-xs font-mono text-subtle mb-8 flex items-center gap-2">
          <Link href="/locations" className="hover:text-ink transition-colors">Locations</Link>
          <span>/</span>
          <span className="text-ink2">{country.name}</span>
        </nav>

        <h1 className="font-display text-4xl lg:text-5xl font-black tracking-tight text-ink mb-5">
          Residential Proxies in {country.name}
        </h1>
        <p className="text-ink2 text-lg font-light leading-relaxed mb-10 max-w-2xl">{locationIntro(country)}</p>

        <div className="grid grid-cols-3 gap-4 mb-12">
          {[
            [country.cityCount.toLocaleString(), country.cityCount === 1 ? 'City covered' : 'Cities covered'],
            [country.stateCount.toLocaleString(), country.stateCount === 1 ? 'Region' : 'Regions'],
            [country.asnCount.toLocaleString(), country.asnCount === 1 ? 'Network' : 'Networks'],
          ].map(([n, l]) => (
            <div key={l} className="border border-border rounded-xl p-5 text-center bg-surface">
              <div className="font-display text-3xl font-bold text-ink tracking-tight">{n}</div>
              <div className="text-[10px] text-subtle uppercase tracking-widest font-mono mt-1">{l}</div>
            </div>
          ))}
        </div>

        <h2 className="font-display font-bold text-2xl text-ink tracking-tight mb-4">Major cities with dedicated targeting</h2>
        <div className="flex flex-wrap gap-2 mb-12">
          {country.majorCities.map((city) => (
            <span key={city} className="text-sm text-ink2 border border-border rounded-full px-4 py-1.5 font-light">
              {city}
            </span>
          ))}
        </div>

        <h2 className="font-display font-bold text-2xl text-ink tracking-tight mb-5">What teams use {country.name} proxies for</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-12">
          {locationUseCases().map((uc) => (
            <div key={uc.title} className="border border-border rounded-xl p-6 bg-white">
              <h3 className="font-display font-bold text-ink mb-2">{uc.title}</h3>
              <p className="text-ink2 text-sm font-light leading-relaxed">{uc.text(country)}</p>
            </div>
          ))}
        </div>

        <div className="border border-border rounded-2xl p-8 bg-ink text-center mb-4">
          <h2 className="font-display text-2xl font-bold text-white tracking-tight mb-2">Start in {country.name} from ${entry.total.toFixed(2)}</h2>
          <p className="text-white/60 font-light text-sm mb-6">Non-expiring bandwidth, city-level targeting, rotating and sticky sessions — no subscription.</p>
          <Link
            href="/auth/signup"
            className="inline-flex items-center gap-2 bg-white text-ink px-7 py-3 rounded-xl font-medium hover:-translate-y-0.5 transition-all"
          >
            Get started →
          </Link>
        </div>
        <p className="text-center text-xs font-mono text-subtle">
          Looking for another market? <Link href="/locations" className="text-accent hover:underline">Browse all locations →</Link>
        </p>
      </main>
      <Footer />
    </>
  )
}
