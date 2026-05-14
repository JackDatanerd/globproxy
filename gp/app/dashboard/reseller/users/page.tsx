import { createClient } from '@/lib/supabase/server'
import ResellerUsersList from '@/components/reseller/ResellerUsersList'

export default async function ResellerUsersPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  
  // 1. Get Reseller Stock limits
  const { data: bw } = await supabase.from('bandwidth_accounts').select('*').eq('user_id',user!.id).single()
  
  // 2. Query 'reseller_transfers' to find the clients they gave GB to
  // (We use a standard join syntax to ensure we retrieve the client's email alongside the history record)
  const { data: transfers } = await supabase
      .from('reseller_transfers')
      .select('*, profiles!reseller_transfers_recipient_id_fkey(email)')
      .eq('reseller_id', user!.id)
      .order('created_at', { ascending: false })

  const stockRemaining = Math.max(0, (bw?.total_gb ?? 0) - (bw?.used_gb ?? 0))

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="font-display font-bold text-2xl text-ink">Client Management</h1>
          <p className="text-muted text-sm mt-1">Easily top-up bandwidth directly to your sub-users accounts</p>
        </div>
        <div className="text-right">
          <div className="text-xs font-mono text-muted">Available stock</div>
          <div className="font-display font-bold text-accent">
            {stockRemaining.toFixed(1)} GB
          </div>
        </div>
      </div>

      <ResellerUsersList 
        subUsers={transfers ?? []} 
        availableGb={stockRemaining} 
        resellerId={user!.id} 
      />
    </div>
  )
}
