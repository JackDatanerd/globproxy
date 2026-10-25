import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { checkVerifiedSession, MFA_COOKIE_NAME } from '@/lib/mfa'
import DashShell from '@/components/dashboard/DashShell'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  // Only what the layout itself needs. `select('*')` pulled payout details,
  // MFA state and the application JSON into every dashboard request, and the
  // whole row was then handed to a client component.
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role, email, is_deleted, is_suspended, mfa_enabled, is_verified_operator, deletion_scheduled_at')
    .eq('id', user.id)
    .single()

  // A failed lookup must not be read as "plain user, nothing wrong": every
  // suspended/deleted/MFA check below would silently pass. Fail closed by
  // throwing. NOTE: app/dashboard/error.tsx does NOT catch this — an error
  // boundary only wraps its segment's page and children, never the layout of
  // the same segment. It is caught by the root boundary, app/error.tsx.
  if (profileError || !profile) {
    throw new Error('Could not load your account. Please refresh and try again.')
  }

  // middleware.ts already enforces this (and signs the session out) for every
  // request under /dashboard — this is defense-in-depth so a suspended
  // account can't reach dashboard data via this layout if middleware is ever
  // bypassed or misconfigured for this route group, the same way admin/layout.tsx
  // independently re-checks role rather than relying on middleware alone.
  if (profile?.is_deleted) redirect('/auth/login?deleted=1')
  if (profile?.is_suspended) redirect('/auth/login?suspended=1')

  // Same defense-in-depth reasoning, for the MFA step-up — see middleware.ts
  // for the primary enforcement. MFA is optional for every role; an account
  // that HAS enabled it must hold a verified-session cookie.
  if (profile?.mfa_enabled) {
    const token = (await cookies()).get(MFA_COOKIE_NAME)?.value
    if (!(await checkVerifiedSession(token, user.id))) redirect('/auth/mfa-verify?next=/dashboard')
  }

  return (
    <DashShell
      role={profile.role ?? 'user'}
      email={profile.email ?? user.email ?? null}
      userId={user.id}
      showMfaBanner={!profile.mfa_enabled}
      verifiedOperator={!!profile.is_verified_operator}
      deletionScheduledAt={profile.deletion_scheduled_at ?? null}
    >
      {children}
    </DashShell>
  )
}
