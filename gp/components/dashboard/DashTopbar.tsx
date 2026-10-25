'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'
import ReportIssueButton from './ReportIssueButton'

// Only the two fields the topbar renders. The layout used to pass the whole
// profiles row (payout details, MFA state, application JSON…) into a client
// component, serialising all of it into the page's HTML payload.
export default function DashTopbar({
  profile, onMenu, menuOpen = false,
}: {
  profile: { role?: string | null; email?: string | null; verifiedOperator?: boolean } | null
  onMenu?: () => void
  menuOpen?: boolean
}) {
  const router = useRouter()
  const [signingOut, setSigningOut] = useState(false)
  async function signOut() {
    if (signingOut) return
    setSigningOut(true)
    // Clears the separate gp_mfa "verified this browser" cookie/session —
    // Supabase's own signOut() below has no idea that cookie exists, so
    // without this a shared machine would stay MFA-verified until the
    // cookie's natural expiry even after the account signs out.
    await fetch('/api/auth/mfa/logout', { method: 'POST' }).catch(() => {})
    const { error } = // Local scope: signing out here must not end the user's other devices
    // (that is what "Sign out of all other devices" is for).
    await createClient().auth.signOut({ scope: 'local' })
    if (error) {
      // Previously reported "Signed out" and navigated away even when the
      // session was still alive.
      toast.error('Couldn\u2019t sign you out — please try again.')
      setSigningOut(false)
      return
    }
    toast.success('Signed out')
    router.push('/')
    router.refresh()
  }
  return (
    <header className="bg-white border-b border-border h-16 flex items-center px-4 md:px-6 gap-2 sm:gap-3 md:gap-4 sticky top-0 z-40 flex-shrink-0">
      {onMenu && (
        <button onClick={onMenu} aria-label={menuOpen ? 'Close menu' : 'Open menu'} aria-expanded={menuOpen} aria-controls="dash-sidebar"
          className="md:hidden -ml-1 w-9 h-9 flex items-center justify-center rounded-lg border border-border text-ink2 hover:text-ink">
          {menuOpen ? '✕' : '☰'}
        </button>
      )}
      <Link href="/dashboard" className="font-display font-black text-lg sm:text-xl text-ink tracking-tight flex-shrink-0">Glob<span className="text-accent">Proxy</span></Link>
      <div className="flex-1" />
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
        {profile?.verifiedOperator && <span title="GlobProxy Verified Operator" className="hidden sm:inline bg-accent2-light text-accent2 text-[10px] font-mono tracking-widest px-2.5 py-1 rounded-full">✓ VERIFIED OPERATOR</span>}
        {profile?.role === 'reseller' && <span className="hidden sm:inline bg-accent2-light text-accent2 text-[10px] font-mono tracking-widest px-2.5 py-1 rounded-full">RESELLER</span>}
        {profile?.role === 'admin' && <span className="hidden sm:inline bg-accent-light text-accent text-[10px] font-mono tracking-widest px-2.5 py-1 rounded-full">ADMIN</span>}
        <span className="text-sm text-ink2 hidden md:block">{profile?.email}</span>
        <ReportIssueButton />
        <button onClick={signOut} disabled={signingOut} className="text-xs disabled:opacity-50 text-muted hover:text-ink border border-border px-2.5 sm:px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap">Sign out</button>
      </div>
    </header>
  )
}
