import { redirect } from 'next/navigation'
import { cookies, headers } from 'next/headers'
import { safeNextPath } from '@/lib/safeNext'
import { createClient } from '@/lib/supabase/server'
import { checkVerifiedSession, MFA_COOKIE_NAME } from '@/lib/mfa'

// /invoice/* had no layout, so unlike /dashboard, /reseller and /admin it had no
// second line of defence behind middleware.ts: the page only checked that
// *someone* was signed in. Invoices are billing/PII documents, so the same
// checks the dashboard layout makes are repeated here — if middleware is ever
// bypassed (its matcher skips some paths) a suspended, deleted or not-yet-
// MFA-verified account still cannot read one.
export default async function InvoiceLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  // Middleware forwards the requested path, so sign-in and the 2FA step return to the
  // invoice that was asked for (they used to drop it / land on Billing).
  const here = safeNextPath((await headers()).get('x-return-path'), '/dashboard/billing')
  if (!user) redirect(`/auth/login?next=${encodeURIComponent(here)}`)

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('is_deleted, is_suspended, mfa_enabled')
    .eq('id', user.id)
    .single()
  // Fail closed: an unreadable profile must not read as "all clear".
  if (error || !profile) throw new Error('Could not load your account. Please refresh and try again.')

  if (profile.is_deleted) redirect('/auth/login?deleted=1')
  if (profile.is_suspended) redirect('/auth/login?suspended=1')

  if (profile.mfa_enabled) {
    const token = (await cookies()).get(MFA_COOKIE_NAME)?.value
    if (!(await checkVerifiedSession(token, user.id))) redirect(`/auth/mfa-verify?next=${encodeURIComponent(here)}`)
  }

  return <>{children}</>
}
