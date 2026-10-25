import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import NewProxyForm from './NewProxyForm'
import { isUuidString } from '@/lib/cursor'

export default async function NewProxyPage({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  const sp = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const { data: bw } = await supabase
    .from('bandwidth_accounts')
    .select('available_gb, total_gb, used_gb, default_auto_topup_enabled, default_auto_topup_threshold_gb, default_auto_topup_amount_gb')
    .eq('user_id', user.id)
    .single()

  const available = bw?.available_gb ?? 0

  // Under the 0.01 GB minimum the form could open but never submit.
  if (available < 0.01) {
    redirect('/dashboard/buy?reason=no_bandwidth')
  }

  // "Duplicate" on a session card: pre-fill from that session. Read through the
  // customer's own session (RLS), targeting columns only — never credentials. A bad
  // or foreign id simply opens the normal empty form.
  let initial: React.ComponentProps<typeof NewProxyForm>['initial'] = null
  if (sp.from && isUuidString(sp.from)) {
    const { data: src } = await supabase
      .from('proxy_credentials')
      .select('label, country, state, city, asn, protocol, session_type, sticky_duration, gb_allocated')
      .eq('id', sp.from)
      .eq('user_id', user.id)
      .maybeSingle()
    if (src) initial = src
  }

  return (
    <NewProxyForm
      availableGb={available}
      initial={initial}
      duplicateOf={initial ? (initial.label || 'Untitled session') : null}
      defaultAutoTopup={{
        enabled: bw?.default_auto_topup_enabled ?? false,
        threshold_gb: bw?.default_auto_topup_threshold_gb ?? null,
        amount_gb: bw?.default_auto_topup_amount_gb ?? null,
      }}
    />
  )
}
