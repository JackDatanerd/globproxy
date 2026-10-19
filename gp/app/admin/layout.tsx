import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { checkVerifiedSession, MFA_COOKIE_NAME } from '@/lib/mfa'
import DashShell from '@/components/dashboard/DashShell'

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')
  const { data: profile, error: profileError } = await supabase.from('profiles').select('role, email, mfa_enabled').eq('id', user.id).single()
  if (profileError || !profile) throw new Error('Could not load your account. Please refresh and try again.')
  if (profile.role !== 'admin') redirect('/dashboard')

  // Defense-in-depth for the MFA step-up — see middleware.ts for primary
  // enforcement. MFA is optional (recommended, via the banner below); an
  // admin who HAS enabled it must be verified.
  if (profile?.mfa_enabled) {
    const mfaToken = (await cookies()).get(MFA_COOKIE_NAME)?.value
    if (!(await checkVerifiedSession(mfaToken, user.id))) redirect('/auth/mfa-verify?next=/admin')
  }
  return (
    <DashShell role="admin" email={profile.email ?? user.email ?? null} showMfaBanner={!profile.mfa_enabled}>
      {children}
    </DashShell>
  )
}
