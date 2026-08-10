import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/server'
import AdminUserControls from '@/components/admin/AdminUserControls'
import AdminSyncUsageButton from '@/components/admin/AdminSyncUsageButton'
import { formatGb } from '@/lib/format'

export default async function AdminUsersPage() {
  const supabase = await createAdminClient()
  
  // Previously this fetched every profile including soft-deleted ones
  // (is_deleted, set by admin/delete-user and user/delete-account), which
  // just accumulate as permanent '[deleted]'/'[deleted]' rows with no way
  // to clear them from this view.
  const { data: users } = await supabase
    .from('profiles')
    .select('*')
    .eq('is_deleted', false)
    .order('created_at', { ascending: false })

  // 2. Fetch bandwidth separately
  const userIds = users?.map(u => u.id) ?? []
  const { data: bwAccounts } = userIds.length > 0
    ? await supabase.from('bandwidth_accounts').select('user_id, available_gb, total_gb, used_gb').in('user_id', userIds)
    : { data: [] }
    
  const bwMap = Object.fromEntries((bwAccounts ?? []).map(b => [b.user_id, b]))

  return (
    <div className="max-w-6xl">
      <div className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="font-display font-bold text-2xl text-ink">All Users</h1>
          <p className="text-muted text-sm mt-1">{users?.length ?? 0} registered accounts</p>
        </div>
        <AdminSyncUsageButton label="Sync all usage now" />
      </div>

      <div className="bg-white border border-border rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            {/* ... Keep your existing thead ... */}
            <tr className="border-b border-border bg-surface">
              {['User', 'Role', 'Total', 'Used', 'Available', 'Status', 'API', 'Joined', 'Actions'].map(h => (
                <th key={h} className="text-left px-5 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users?.map((u, i) => {
              // 3. Use the mapped bandwidth data
              const bw = bwMap[u.id]
              return (
                <tr key={u.id} className={`${i < users.length - 1 ? 'border-b border-border' : ''} hover:bg-surface transition-colors`}>
                  <td className="px-5 py-3.5">
                    <Link href={`/admin/users/${u.id}`} className="text-sm font-medium text-ink hover:text-accent transition-colors">
                      {u.full_name || '—'}
                    </Link>
                    <div className="text-xs font-mono text-muted">{u.email}</div>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={`text-[10px] font-mono px-2.5 py-1 rounded-full ${
                      u.role === 'admin' ? 'bg-accent-light text-accent' :
                      u.role === 'reseller' ? 'bg-accent2-light text-accent2' :
                      'bg-surface text-muted border border-border'
                    }`}>{u.role}</span>
                    {/* MFA is mandatory for admin/reseller — surface non-compliance
                        (still-mid-setup accounts) directly in the list, not just
                        on each user's detail page. */}
                    {(u.role === 'admin' || u.role === 'reseller') && !u.mfa_enabled && (
                      <span className="ml-1.5 text-[10px] font-mono px-2 py-1 rounded-full bg-red-50 text-red-500" title="Two-factor authentication not yet set up">
                        no 2FA
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3.5 font-mono text-sm text-ink">{formatGb(bw?.total_gb)} GB</td>
                  <td className="px-5 py-3.5 font-mono text-sm text-ink">{formatGb(bw?.used_gb)} GB</td>
                  <td className="px-5 py-3.5 font-mono text-sm text-ink">{formatGb(bw?.available_gb)} GB</td>
                  {/* ... Keep the rest of your existing td elements ... */}
                  <td className="px-5 py-3.5">
                    {u.is_suspended ? <span className="text-[10px] font-mono bg-red-50 text-red-500 px-2.5 py-1 rounded-full">Suspended</span> : <span className="text-[10px] font-mono bg-accent2-light text-accent2 px-2.5 py-1 rounded-full">Active</span>}
                  </td>
                  <td className="px-5 py-3.5">
                    {u.role === 'reseller' ? (u.api_access ? <span className="text-[10px] font-mono bg-accent-light text-accent px-2.5 py-1 rounded-full">Enabled</span> : <span className="text-[10px] font-mono bg-surface text-muted border border-border px-2.5 py-1 rounded-full">Off</span>) : <span className="text-[10px] text-muted">—</span>}
                  </td>
                  <td className="px-5 py-3.5 text-xs font-mono text-muted">
                    {new Date(u.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </td>
                  <td className="px-5 py-3.5">
                    <AdminUserControls user={u} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}