import Link from 'next/link'
import Navbar from '@/components/Navbar'
import Footer from '@/components/Footer'
import { LOCATION_COUNTRIES } from '@/lib/locations/data'
import { pageMetadata } from '@/lib/seo'

export const metadata = pageMetadata({
  title: 'Residential Proxy Locations — 195 Countries — GlobProxy',
  description:
    'Browse GlobProxy\'s residential proxy coverage by country — real network and city-level data, not a static list. Non-expiring bandwidth in every market.',
  path: '/locations',
})

export default function LocationsIndexPage() {
  const countries = [...LOCATION_COUNTRIES].sort((a, b) => a.name.localeCompare(b.name))

  return (
    <>
      <Navbar />
      <main id="main" className="max-w-6xl mx-auto px-6 py-16">
        <div className="mb-12">
          <div className="inline-block bg-accent-light text-accent text-xs font-mono tracking-widest uppercase px-4 py-1.5 rounded-full mb-4">
            Locations
          </div>
          <h1 className="font-display text-4xl lg:text-5xl font-black tracking-tight text-ink mb-3">
            Residential proxies,<br />by country.
          </h1>
          <p className="text-ink2 font-light leading-relaxed max-w-xl">
            Coverage across 195 countries total. These pages cover the markets with the deepest city-level density — see the dashboard&apos;s location picker for the full list.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {countries.map((c) => (
            <Link
              key={c.code}
              href={`/locations/${c.code}`}
              className="group border border-border rounded-xl p-5 hover:border-accent hover:shadow-sm transition-all bg-white flex items-center justify-between"
            >
              <div>
                <div className="font-display font-bold text-ink group-hover:text-accent transition-colors">{c.name}</div>
                <div className="text-xs text-subtle font-mono mt-1">{c.cityCount.toLocaleString()} {c.cityCount === 1 ? 'city' : 'cities'} · {c.asnCount.toLocaleString()} {c.asnCount === 1 ? 'network' : 'networks'}</div>
              </div>
              <span className="text-accent opacity-0 group-hover:opacity-100 transition-opacity">→</span>
            </Link>
          ))}
        </div>
      </main>
      <Footer />
    </>
  )
}
