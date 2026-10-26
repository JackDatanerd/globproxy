'use client'
import { useCallback, useState } from 'react'
import DashSidebar from '@/components/dashboard/DashSidebar'
import DashTopbar from '@/components/dashboard/DashTopbar'
import MfaRecommendBanner from '@/components/dashboard/MfaRecommendBanner'
import DeletionScheduledBanner from '@/components/dashboard/DeletionScheduledBanner'

// Holds the one piece of client state the dashboard chrome shares — whether
// the mobile nav drawer is open — so the topbar's menu button and the
// sidebar can talk to each other while the layout itself stays a server
// component (page content arrives as `children`).
export default function DashShell({
  role, email, userId = null, showMfaBanner, verifiedOperator = false, deletionScheduledAt = null, inboxUnread = 0, children,
}: {
  role: string
  email: string | null
  userId?: string | null
  showMfaBanner: boolean
  verifiedOperator?: boolean
  deletionScheduledAt?: string | null
  inboxUnread?: number
  children: React.ReactNode
}) {
  const [navOpen, setNavOpen] = useState(false)
  const closeNav = useCallback(() => setNavOpen(false), [])

  return (
    <div className="min-h-screen bg-surface flex flex-col">
      <DashTopbar profile={{ role, email, verifiedOperator }} onMenu={() => setNavOpen(o => !o)} menuOpen={navOpen} />
      {/* No overflow-* on this row or <main>: an ancestor with overflow set
          becomes the scroll container for `position: sticky`, and since neither
          is height-constrained it never scrolls — so every sticky element inside
          a page (the new-session summary/Create button) silently stopped
          sticking. The document scrolls; the sidebar sticks itself. */}
      <div className="flex flex-1">
        <DashSidebar role={role} email={email} open={navOpen} onClose={closeNav} inboxUnread={inboxUnread} />
        <main className="flex-1 min-w-0 p-4 sm:p-6 md:p-8">
          {deletionScheduledAt && <DeletionScheduledBanner when={deletionScheduledAt} />}
          {showMfaBanner && <MfaRecommendBanner role={role} userId={userId} />}
          {children}
        </main>
      </div>
    </div>
  )
}
