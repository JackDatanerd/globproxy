import { createAdminClient } from '@/lib/supabase/server'
import AdminStockPanel from '@/components/admin/AdminStockPanel'

export default async function AdminSettingsPage() {
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
    </div>
  )
}
