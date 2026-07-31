import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ResellerUsersList from '@/components/reseller/ResellerUsersList'

export default async function ResellerUsersPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  // ResellerUsersList's "Your Clients" roster is built from transfer history
  // (recipient_id, gb_amount, joined profiles) — it was previously fed
  // proxy_credentials rows instead, which have neither of those fields, so
  // every client collapsed into a single broken entry with a 0 GB total.
  // reseller_transfers is the correct source, same as /reseller/transfers
  // and /reseller/earnings already use.
  const [{ data: bw }, { data: subUsers }] = await Promise.all([
    supabase.from('bandwidth_accounts').select('*').eq('user_id',user.id).single(),
    supabase.from('reseller_transfers').select('*, profiles!reseller_transfers_recipient_id_fkey(email,full_name)').eq('reseller_id',user.id).order('created_at',{ascending:false}),
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
      <ResellerUsersList subUsers={subUsers??[]} availableGb={bw?.available_gb??0} resellerId={user.id} />
    </div>
  )
}
