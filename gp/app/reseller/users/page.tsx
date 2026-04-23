import { createClient } from '@/lib/supabase/server'
import ResellerUsersList from '@/components/reseller/ResellerUsersList'

export default async function ResellerUsersPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const [{ data: bw }, { data: subUsers }] = await Promise.all([
    supabase.from('bandwidth_accounts').select('*').eq('user_id',user!.id).single(),
    supabase.from('proxy_credentials').select('*, profiles!proxy_credentials_user_id_fkey(email,full_name)').eq('created_by',user!.id).order('created_at',{ascending:false}),
  ])
  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="font-display font-bold text-2xl text-ink">Sub-users</h1>
          <p className="text-muted text-sm mt-1">Manage clients and allocate bandwidth</p>
        </div>
        <div className="text-right">
          <div className="text-xs font-mono text-muted">Available stock</div>
          <div className="font-display font-bold text-accent">{(bw?.available_gb??0).toFixed(1)} GB</div>
        </div>
      </div>
      <ResellerUsersList subUsers={subUsers??[]} availableGb={bw?.available_gb??0} resellerId={user!.id} />
    </div>
  )
}
