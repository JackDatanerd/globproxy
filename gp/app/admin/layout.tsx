import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { checkVerifiedSession, MFA_COOKIE_NAME } from '@/lib/mfa'
import DashSidebar from '@/components/dashboard/DashSidebar'
import DashTopbar from '@/components/dashboard/DashTopbar'
import MfaRecommendBanner from '@/components/dashboard/MfaRecommendBanner'

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')
  const { data: profile } = await supabase.from('profiles').select('*').eq('id',user.id).single()
  if (profile?.role !== 'admin') redirect('/dashboard')

  // Defense-in-depth for the MFA step-up — see middleware.ts for primary
  // enforcement. MFA is optional (recommended, via the banner below); an
  // admin who HAS enabled it must be verified.
  if (profile?.mfa_enabled) {
    const mfaToken = (await cookies()).get(MFA_COOKIE_NAME)?.value
    if (!(await checkVerifiedSession(mfaToken, user.id))) redirect('/auth/mfa-verify?next=/admin')
  }
  return (
    <div className="min-h-screen bg-surface flex flex-col">
      <DashTopbar profile={profile} />
      <div className="flex flex-1 overflow-hidden">
        <DashSidebar role="admin" />
        <main className="flex-1 p-8 overflow-y-auto">
          {!profile?.mfa_enabled && <MfaRecommendBanner role="admin" />}
          {children}
        </main>
      </div>
    </div>
  )
}
