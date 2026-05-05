import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ApiKeysClient from './ApiKeysClient'

export default async function ApiKeysPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, api_access')
    .eq('id', user.id)
    .single()

  // Guard: must be reseller with api_access, or admin
  if (profile?.role === 'user' || (!profile?.api_access && profile?.role !== 'admin')) {
    return (
      <div className="max-w-2xl">
        <div className="mb-8">
          <h1 className="font-display font-bold text-2xl text-ink">API Access</h1>
        </div>
        <div className="bg-white border border-border rounded-xl p-10 text-center">
          <div className="text-3xl mb-4">⌘</div>
          <h2 className="font-display font-bold text-lg text-ink mb-2">API access not enabled</h2>
          <p className="text-muted text-sm font-light max-w-sm mx-auto mb-6 leading-relaxed">
            API access is available to resellers with approval. It allows programmatic
            sub-user creation, bandwidth allocation, and usage tracking.
          </p>
          <a href="mailto:support@globproxy.com?subject=API Access Request"
            className="inline-flex items-center gap-2 bg-accent text-white px-6 py-2.5 rounded-xl text-sm font-medium hover:opacity-90 transition-opacity">
            Request API access →
          </a>
        </div>
      </div>
    )
  }

  return <ApiKeysClient />
}
