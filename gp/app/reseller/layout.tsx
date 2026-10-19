import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { checkVerifiedSession, MFA_COOKIE_NAME } from '@/lib/mfa'
import DashShell from '@/components/dashboard/DashShell'

export default async function ResellerLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const { data: profile, error: profileError } = await supabase
    .from('profiles').select('role, email, is_deleted, is_suspended, mfa_enabled').eq('id', user.id).single()
  if (profileError || !profile) throw new Error('Could not load your account. Please refresh and try again.')

  if (profile?.role !== 'reseller' && profile?.role !== 'admin') redirect('/dashboard')
  // Defense-in-depth — see app/dashboard/layout.tsx for rationale.
  if (profile?.is_deleted) redirect('/auth/login?deleted=1')
  if (profile?.is_suspended) redirect('/auth/login?suspended=1')

  // Defense-in-depth for the MFA step-up — see middleware.ts for primary
  // enforcement. MFA is optional; an enrolled account must be verified.
  if (profile?.mfa_enabled) {
    const mfaToken = (await cookies()).get(MFA_COOKIE_NAME)?.value
    if (!(await checkVerifiedSession(mfaToken, user.id))) redirect('/auth/mfa-verify?next=/reseller')
  }

  return (
    <DashShell role={profile.role ?? 'reseller'} email={profile.email ?? user.email ?? null} showMfaBanner={!profile.mfa_enabled}>
      {children}
    </DashShell>
  )
}
