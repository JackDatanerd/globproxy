'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

const NAV_LINKS: [string, string][] = [
  ['/#features', 'Features'],
  ['/#pricing', 'Pricing'],
  ['/#reseller', 'Resellers'],
  ['/#affiliates', 'Affiliates'],
  ['/#compare', 'Compare'],
  ['/blog', 'Blog'],
  ['/help', 'Help'],
]

// 'unknown' until the first local session read resolves. The auth buttons used to render as signed-out
// and then swap, so a signed-in visitor saw "Sign in / Get started" flash on every page; the slot is
// now reserved (invisible) until we know. We read the session from the local cookie (getSession) and
// follow onAuthStateChange instead of calling getUser(), which was a Supabase Auth round-trip on
// every page view. This is display-only; nothing here is an authorisation decision.
type AuthState = 'unknown' | 'in' | 'out'

export default function Navbar() {
  const [auth, setAuth] = useState<AuthState>('unknown')
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)
  const pathname = usePathname()
  const toggleRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const sb = createClient()
    let alive = true
    sb.auth.getSession().then(({ data }) => { if (alive) setAuth(data.session ? 'in' : 'out') })
    const { data: sub } = sb.auth.onAuthStateChange((_e, session) => { if (alive) setAuth(session ? 'in' : 'out') })
    const h = () => setScrolled(window.scrollY > 10)
    h()
    window.addEventListener('scroll', h, { passive: true })
    return () => {
      alive = false
      sub.subscription.unsubscribe()
      window.removeEventListener('scroll', h)
    }
  }, [])

  // Close the mobile menu on navigation, on Escape (returning focus to the toggle) and when the
  // viewport grows past the lg breakpoint (1024px: below it the 7 links + both buttons do not fit).
  useEffect(() => { setOpen(false) }, [pathname])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); toggleRef.current?.focus() }
    }
    const mq = window.matchMedia('(min-width: 1024px)')
    const onMq = () => { if (mq.matches) setOpen(false) }
    window.addEventListener('keydown', onKey)
    mq.addEventListener('change', onMq)
    return () => { window.removeEventListener('keydown', onKey); mq.removeEventListener('change', onMq) }
  }, [open])

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:bg-ink focus:text-white focus:px-4 focus:py-2 focus:rounded-lg focus:text-sm"
      >
        Skip to content
      </a>
      <nav
        aria-label="Main"
        className={`sticky top-0 z-50 border-b border-border transition-all ${scrolled || open ? 'bg-white/95 backdrop-blur-md shadow-sm' : 'bg-white'}`}
      >
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
          <Link href="/" className="font-display font-black text-xl sm:text-2xl text-ink tracking-tight">Glob<span className="text-accent">Proxy</span></Link>
          <div className="hidden lg:flex items-center gap-6 xl:gap-7">
            {NAV_LINKS.map(([h, l]) => (
              <Link key={h} href={h} className="text-ink2 text-sm hover:text-ink transition-colors">{l}</Link>
            ))}
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <div className={`flex items-center gap-2 sm:gap-3 min-w-[7rem] justify-end ${auth === 'unknown' ? 'invisible' : ''}`} aria-hidden={auth === 'unknown'}>
              {auth === 'in' ? (
                <Link href="/dashboard" className="bg-accent text-white px-4 sm:px-5 py-2 rounded-lg text-sm font-medium hover:opacity-90 transition-opacity">Dashboard</Link>
              ) : (
                <>
                  <Link href="/auth/login" className="hidden sm:inline-block text-ink2 text-sm border border-border px-4 py-2 rounded-lg hover:border-ink2 transition-colors">Sign in</Link>
                  <Link href="/auth/signup" className="bg-accent text-white px-4 sm:px-5 py-2 rounded-lg text-sm font-medium shadow-[0_2px_8px_rgba(0,87,255,.25)] hover:-translate-y-0.5 transition-all">Get started</Link>
                </>
              )}
            </div>
            <button
              ref={toggleRef}
              type="button"
              className="lg:hidden inline-flex items-center justify-center w-10 h-10 -mr-1 rounded-lg text-ink hover:bg-surface transition-colors"
              aria-label={open ? 'Close menu' : 'Open menu'}
              aria-expanded={open}
              aria-controls="mobile-menu"
              onClick={() => setOpen((o) => !o)}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
              </svg>
            </button>
          </div>
        </div>
        {open && (
          <div id="mobile-menu" className="lg:hidden border-t border-border bg-white max-h-[calc(100vh-4rem)] overflow-y-auto">
            <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3 flex flex-col">
              {NAV_LINKS.map(([h, l]) => (
                <Link key={h} href={h} onClick={() => setOpen(false)} className="py-3 text-ink2 text-base border-b border-border/60 last:border-none hover:text-ink">{l}</Link>
              ))}
              <div className="flex flex-col gap-2 pt-4 pb-2">
                {auth === 'in' ? (
                  <Link href="/dashboard" onClick={() => setOpen(false)} className="bg-accent text-white px-5 py-3 rounded-lg text-sm font-medium text-center">Dashboard</Link>
                ) : (
                  <>
                    <Link href="/auth/signup" onClick={() => setOpen(false)} className="bg-accent text-white px-5 py-3 rounded-lg text-sm font-medium text-center">Get started</Link>
                    <Link href="/auth/login" onClick={() => setOpen(false)} className="text-ink2 text-sm border border-border px-5 py-3 rounded-lg text-center">Sign in</Link>
                  </>
                )}
              </div>
              <div className="flex gap-5 pt-3 pb-1 text-xs font-mono text-subtle">
                <Link href="/locations" onClick={() => setOpen(false)} className="hover:text-ink">Locations</Link>
                <Link href="/status" onClick={() => setOpen(false)} className="hover:text-ink">Status</Link>
                <Link href="/terms" onClick={() => setOpen(false)} className="hover:text-ink">Terms</Link>
                <Link href="/privacy" onClick={() => setOpen(false)} className="hover:text-ink">Privacy</Link>
              </div>
            </div>
          </div>
        )}
      </nav>
    </>
  )
}
