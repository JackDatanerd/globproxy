import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import NewProxyForm from './NewProxyForm'

export default async function NewProxyPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const { data: bw } = await supabase
    .from('bandwidth_accounts')
    .select('available_gb, total_gb, used_gb, default_auto_topup_enabled, default_auto_topup_threshold_gb, default_auto_topup_amount_gb')
    .eq('user_id', user.id)
    .single()

  const available = bw?.available_gb ?? 0

  if (available <= 0) {
    redirect('/dashboard/buy?reason=no_bandwidth')
  }

  return (
    <NewProxyForm
      availableGb={available}
      defaultAutoTopup={{
        enabled: bw?.default_auto_topup_enabled ?? false,
        threshold_gb: bw?.default_auto_topup_threshold_gb ?? null,
        amount_gb: bw?.default_auto_topup_amount_gb ?? null,
      }}
    />
  )
}
