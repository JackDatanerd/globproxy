import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import NewProxyForm from '@/components/dashboard/NewProxyForm'

export default async function NewProxyPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const { data: bw } = await supabase
    .from('bandwidth_accounts')
    .select('available_gb')
    .eq('user_id', user.id)
    .single()

  return <NewProxyForm availableGb={bw?.available_gb ?? 0} />
}
