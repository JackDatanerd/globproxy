import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ApiKeysClient from './ApiKeysClient'
import ApiAccessRequestForm from './ApiAccessRequestForm'

export default async function ApiKeysPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, api_access, api_access_status')
    .eq('id', user.id)
    .single()

  // A plain 'user' account has nothing to point API access at (no
  // sub-user allocation to automate) until they become a reseller first —
  // this is the one case that isn't "apply for API access", it's "apply
  // to be a reseller, then apply for API access".
  if (profile?.role === 'user') {
    return (
      <div className="max-w-2xl">
        <div className="mb-8">
          <h1 className="font-display font-bold text-2xl text-ink">API Access</h1>
        </div>
        <div className="bg-white border border-border rounded-xl p-10 text-center">
          <div className="text-3xl mb-4">⌘</div>
          <h2 className="font-display font-bold text-lg text-ink mb-2">API access is for resellers</h2>
          <p className="text-muted text-sm font-light max-w-sm mx-auto mb-6 leading-relaxed">
            It lets you automate sub-user creation, bandwidth allocation, and usage tracking for your own
            clients — so it's only available once you're reselling. Become a reseller first, then you'll
            be able to request API access from this page.
          </p>
          <a href="/dashboard/settings?apply_reseller=1"
            className="inline-flex items-center gap-2 bg-accent text-white px-6 py-2.5 rounded-xl text-sm font-medium hover:opacity-90 transition-opacity">
            Become a reseller →
          </a>
        </div>
      </div>
    )
  }

  // Reseller without api_access yet — show the application flow (or its
  // current pending/rejected state). Previously this was a dead-end
  // mailto: link, and the sidebar never even linked here unless api_access
  // was already true, so a reseller who didn't already know API access
  // existed had no way to find this page at all (see DashSidebar.tsx).
  if (profile?.role === 'reseller' && !profile?.api_access) {
    return <ApiAccessRequestForm status={profile.api_access_status ?? null} />
  }

  return <ApiKeysClient />
}
