import { createAdminClient } from '@/lib/supabase/server'
import AdminUserControls from '@/components/admin/AdminUserControls'

export default async function AdminUsersPage() {
  const supabase = await createAdminClient()
  const { data: users } = await supabase
    .from('profiles')
    .select('*')
    .order('created_at', { ascending: false })

  const userIds = users?.map(u => u.id) ?? []
  const { data: bwAccounts } = userIds.length > 0
    ? await supabase.from('bandwidth_accounts').select('user_id, total_gb, used_gb').in('user_id', userIds)
    : { data: [] }
  const bwMap = Object.fromEntries((bwAccounts ?? []).map(b => [b.user_id, b]))

  return (
    <div className="max-w-6xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">All Users</h1>
        <p className="text-muted text-sm mt-1">{users?.length ?? 0} registered accounts</p>
      </div>
      <div className="bg-white border border-border rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-surface">
              {['User', 'Role', 'Stock', 'Status', 'Joined', 'Actions'].map(h => (
                <th key={h} className="text-left px-5 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users?.map((u, i) => {
              const bw = bwMap[u.id]
              const available = (bw?.total_gb ?? 0) - (bw?.used_gb ?? 0)
              return (
                <tr key={u.id} className="border-b border-border hover:bg-surface">
                  <td className="px-5 py-3.5">
                    <div className="text-sm font-medium text-ink">{u.full_name || '-'}</div>
                    <div className="text-xs font-mono text-muted">{u.email}</div>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={`text-[10px] font-mono px-2.5 py-1 rounded-full ${u.role === 'admin' ? 'bg-accent-light text-accent' : u.role === 'reseller' ? 'bg-accent2-light text-accent2' : 'bg-surface text-muted border border-border'}`}>
                      {u.role}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 font-mono text-sm">{available.toFixed(1)} GB</td>
                  <td className="px-5 py-3.5">
                    {u.is_suspended
                      ? <span className="text-[10px] font-mono bg-red-50 text-red-500 px-2.5 py-1 rounded-full">Suspended</span>
                      : <span className="text-[10px] font-mono bg-accent2-light text-accent2 px-2.5 py-1 rounded-full">Active</span>
                    }
                  </td>
                  <td className="px-5 py-3.5 text-xs font-mono text-muted">
                    {new Date(u.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </td>
                  <td className="px-5 py-3.5"><AdminUserControls user={u} /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
