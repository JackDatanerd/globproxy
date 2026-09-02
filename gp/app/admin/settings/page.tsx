import { createClient, createAdminClient } from '@/lib/supabase/server'
import AdminStockPanel from '@/components/admin/AdminStockPanel'
import AdminAccountSecurity from '@/components/admin/AdminAccountSecurity'
import BenchmarkSettings from '@/components/admin/BenchmarkSettings'

export default async function AdminSettingsPage() {
  const session = await createClient()
  const { data: { user } } = await session.auth.getUser()

  const admin = await createAdminClient()
  const [{ data: setting }, { data: candidates }] = await Promise.all([
    admin.from('platform_settings').select('value').eq('key', 'benchmark_credential_id').single(),
    user
      ? admin.from('proxy_credentials')
          .select('id, host, gb_allocated, gb_used, created_at')
          .eq('user_id', user.id)
          .eq('protocol', 'http')
          .eq('status', 'active')
          .order('created_at', { ascending: false })
      : Promise.resolve({ data: [] }),
  ])

  const currentCredentialId = setting?.value || null
  let currentCredentialLabel: string | null = null
  if (currentCredentialId) {
    const { data: cred } = await admin.from('proxy_credentials').select('host').eq('id', currentCredentialId).single()
    currentCredentialLabel = cred?.host ?? null
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">Platform Settings</h1>
        <p className="text-muted text-sm mt-1">Stock management and platform configuration</p>
      </div>
      <AdminStockPanel />
      <div className="bg-white border border-border rounded-xl p-6 mt-5">
        <h2 className="font-display font-bold text-base text-ink mb-4">Paystack webhook</h2>
        <div className="bg-surface border border-border rounded-lg p-4">
          <div className="text-[10px] font-mono text-muted mb-1">Webhook URL — add this in your Paystack dashboard</div>
          <div className="font-mono text-sm text-ink">https://globproxy.com/api/webhooks/paystack</div>
        </div>
        <p className="text-xs text-muted mt-3 font-light">Set this URL in Paystack → Settings → Webhooks. Event: <span className="font-mono">charge.success</span></p>
      </div>

      <BenchmarkSettings
        currentCredentialId={currentCredentialId}
        currentCredentialLabel={currentCredentialLabel}
        candidates={candidates ?? []}
      />

      {/* Account & security — password + MFA management for the admin's
          own account. Previously missing entirely from this page, the only
          time an admin ever touched MFA was the one-time mandatory setup
          screen at first login, with no way back in afterward short of a
          database edit. */}
      <div className="mt-8 mb-4">
        <h2 className="font-display font-bold text-lg text-ink">Your account</h2>
        <p className="text-muted text-sm mt-1">Password and two-factor authentication for your own admin login</p>
      </div>
      <AdminAccountSecurity />
    </div>
  )
}
