'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'

export default function DashTopbar({ profile }: { profile: any }) {
  const router = useRouter()
  async function signOut() {
    // Clears the separate gp_mfa "verified this browser" cookie/session —
    // Supabase's own signOut() below has no idea that cookie exists, so
    // without this a shared machine would stay MFA-verified until the
    // cookie's natural expiry even after the account signs out.
    await fetch('/api/auth/mfa/logout', { method: 'POST' }).catch(() => {})
    await createClient().auth.signOut()
    toast.success('Signed out')
    router.push('/')
  }
  return (
    <header className="bg-white border-b border-border h-16 flex items-center px-6 gap-4 sticky top-0 z-40 flex-shrink-0">
      <Link href="/" className="font-display font-black text-xl text-ink tracking-tight">Glob<span className="text-accent">Proxy</span></Link>
      <div className="flex-1" />
      <div className="flex items-center gap-3">
        {profile?.role === 'reseller' && <span className="bg-accent2-light text-accent2 text-[10px] font-mono tracking-widest px-2.5 py-1 rounded-full">RESELLER</span>}
        {profile?.role === 'admin' && <span className="bg-accent-light text-accent text-[10px] font-mono tracking-widest px-2.5 py-1 rounded-full">ADMIN</span>}
        <span className="text-sm text-ink2 hidden md:block">{profile?.email}</span>
        <button onClick={signOut} className="text-xs text-muted hover:text-ink border border-border px-3 py-1.5 rounded-lg transition-colors">Sign out</button>
      </div>
    </header>
  )
}
