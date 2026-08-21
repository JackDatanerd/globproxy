import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { mfaRequiredForRole, checkVerifiedSession, MFA_COOKIE_NAME } from '@/lib/mfa'
import DashSidebar from '@/components/dashboard/DashSidebar'
import DashTopbar from '@/components/dashboard/DashTopbar'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  // middleware.ts already enforces this (and signs the session out) for every
  // request under /dashboard — this is defense-in-depth so a suspended
  // account can't reach dashboard data via this layout if middleware is ever
  // bypassed or misconfigured for this route group, the same way admin/layout.tsx
  // independently re-checks role rather than relying on middleware alone.
  if (profile?.is_deleted) redirect('/auth/login?deleted=1')
  if (profile?.is_suspended) redirect('/auth/login?suspended=1')

  // Same defense-in-depth reasoning, for the mandatory-MFA gate — see
  // middleware.ts for the primary enforcement and full rationale.
  if (mfaRequiredForRole(profile?.role)) {
    if (!profile?.mfa_enabled) redirect('/auth/mfa-setup?next=/dashboard')
    const token = (await cookies()).get(MFA_COOKIE_NAME)?.value
    if (!(await checkVerifiedSession(token, user.id))) redirect('/auth/mfa-verify?next=/dashboard')
  }

  return (
    <div className="min-h-screen bg-surface flex flex-col">
      <DashTopbar profile={profile} />
      <div className="flex flex-1 overflow-hidden">
        <DashSidebar role={profile?.role ?? 'user'} apiAccess={profile?.api_access ?? false} />
        <main className="flex-1 p-8 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}
