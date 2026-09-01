'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export default function Navbar() {
  const [user, setUser] = useState<any>(null)
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const sb = createClient()
    sb.auth.getUser().then(({ data }) => setUser(data.user))
    const h = () => setScrolled(window.scrollY > 10)
    window.addEventListener('scroll', h)
    return () => window.removeEventListener('scroll', h)
  }, [])

  return (
    <nav className={`sticky top-0 z-50 border-b border-border transition-all ${scrolled ? 'bg-white/95 backdrop-blur-md shadow-sm' : 'bg-white'}`}>
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link href="/" className="font-display font-black text-2xl text-ink tracking-tight">Glob<span className="text-accent">Proxy</span></Link>
        <div className="hidden md:flex items-center gap-7">
          {[['/#features','Features'],['/#pricing','Pricing'],['/#reseller','Resellers'],['/#affiliates','Affiliates'],['/#compare','Compare'],['/blog','Blog']].map(([h,l]) => (
            <Link key={h} href={h} className="text-ink2 text-sm hover:text-ink transition-colors">{l}</Link>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {user ? (
            <Link href="/dashboard" className="bg-accent text-white px-5 py-2 rounded-lg text-sm font-medium hover:opacity-90 transition-opacity">Dashboard</Link>
          ) : (
            <>
              <Link href="/auth/login" className="text-ink2 text-sm border border-border px-4 py-2 rounded-lg hover:border-ink2 transition-colors">Sign in</Link>
              <Link href="/auth/signup" className="bg-accent text-white px-5 py-2 rounded-lg text-sm font-medium shadow-[0_2px_8px_rgba(0,87,255,.25)] hover:-translate-y-0.5 transition-all">Get started</Link>
            </>
          )}
        </div>
      </div>
    </nav>
  )
}
