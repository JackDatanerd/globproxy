import Link from 'next/link'

// One footer for every public page. It used to exist only at the bottom of the homepage, so a visitor
// on a blog article, help page, status page or location page (and on mobile, where the Navbar links
// are hidden) had no route to Terms, Privacy, Refunds, Status or Locations. Text colours are held at
// >= 4.5:1 on the ink background (white/50 is 5.3:1); the old white/25-30 was 2.2-2.7:1.
const COLUMNS: { title: string; links: [string, string][] }[] = [
  { title: 'Product', links: [['/#features', 'Features'], ['/#pricing', 'Pricing'], ['/#reseller', 'Resellers'], ['/#compare', 'Compare'], ['/docs/api', 'API Docs']] },
  { title: 'Resources', links: [['/blog', 'Blog'], ['/help', 'Help centre'], ['/locations', 'Locations'], ['/status', 'Network status']] },
  { title: 'Support', links: [['mailto:support@globproxy.com', 'Contact us'], ['mailto:sales@globproxy.com', 'Sales']] },
  { title: 'Legal', links: [['/terms', 'Terms of Service'], ['/privacy', 'Privacy Policy'], ['/refunds', 'Refund Policy']] },
]

export default function Footer() {
  return (
    <footer className="bg-ink border-t border-white/5 pt-14 pb-8">
      <div className="max-w-6xl mx-auto px-6">
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-10 mb-12">
          <div className="col-span-2 lg:col-span-1">
            <div className="font-display font-black text-2xl text-white mb-3">Glob<span className="text-accent">Proxy</span></div>
            <p className="text-white/50 text-sm font-light leading-relaxed max-w-xs">Residential proxies that never expire. Buy once, use forever. No subscriptions.</p>
          </div>
          {COLUMNS.map((col) => (
            <nav key={col.title} aria-label={col.title}>
              <div className="text-white/50 text-xs font-mono tracking-widest uppercase mb-4">{col.title}</div>
              {col.links.map(([href, label]) =>
                href.startsWith('mailto:') ? (
                  <a key={href} href={href} className="block text-white/60 text-sm mb-2.5 hover:text-white transition-colors">{label}</a>
                ) : (
                  <Link key={href} href={href} className="block text-white/60 text-sm mb-2.5 hover:text-white transition-colors">{label}</Link>
                ),
              )}
            </nav>
          ))}
        </div>
        <div className="border-t border-white/5 pt-6 flex flex-wrap gap-2 justify-between items-center">
          <p className="text-white/50 text-xs">© {new Date().getFullYear()} GlobProxy · Saltern Studio. All rights reserved.</p>
          <p className="text-white/50 text-xs font-mono">globproxy.com</p>
        </div>
      </div>
    </footer>
  )
}
