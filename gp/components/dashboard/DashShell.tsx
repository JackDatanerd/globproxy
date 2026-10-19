'use client'
import { useCallback, useState } from 'react'
import DashSidebar from '@/components/dashboard/DashSidebar'
import DashTopbar from '@/components/dashboard/DashTopbar'
import MfaRecommendBanner from '@/components/dashboard/MfaRecommendBanner'

// Holds the one piece of client state the dashboard chrome shares — whether
// the mobile nav drawer is open — so the topbar's menu button and the
// sidebar can talk to each other while the layout itself stays a server
// component (page content arrives as `children`).
export default function DashShell({
  role, email, showMfaBanner, children,
}: {
  role: string
  email: string | null
  showMfaBanner: boolean
  children: React.ReactNode
}) {
  const [navOpen, setNavOpen] = useState(false)
  const closeNav = useCallback(() => setNavOpen(false), [])

  return (
    <div className="min-h-screen bg-surface flex flex-col">
      <DashTopbar profile={{ role, email }} onMenu={() => setNavOpen(o => !o)} menuOpen={navOpen} />
      <div className="flex flex-1 overflow-hidden">
        <DashSidebar role={role} open={navOpen} onClose={closeNav} />
        <main className="flex-1 min-w-0 p-4 sm:p-6 md:p-8 overflow-y-auto">
          {showMfaBanner && <MfaRecommendBanner role={role} />}
          {children}
        </main>
      </div>
    </div>
  )
}
