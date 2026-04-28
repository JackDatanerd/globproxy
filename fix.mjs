import { writeFileSync } from 'fs'

writeFileSync('gp/app/admin/orders/page.tsx', `import { createAdminClient } from '@/lib/supabase/server'

export default async function AdminOrdersPage() {
  const supabase = await createAdminClient()
  const { data: orders } = await supabase
    .from('orders')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200)

  const paid = orders?.filter(o => o.payment_status === 'paid') ?? []
  const totalRevenue = paid.reduce((s, o) => s + Number(o.amount_usd), 0)
  const totalGb = paid.reduce((s, o) => s + Number(o.gb_amount), 0)

  const userIds = [...new Set(orders?.map(o => o.user_id).filter(Boolean) ?? [])]
  const { data: profiles } = userIds.length > 0
    ? await supabase.from('profiles').select('id, email, full_name').in('id', userIds)
    : { data: [] }
  const profileMap = Object.fromEntries((profiles ?? []).map(p => [p.id, p]))

  return (
    <div className="max-w-6xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">Orders</h1>
        <p className="text-muted text-sm mt-1">All purchase activity across the platform</p>
      </div>
      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="bg-white border border-border rounded-xl p-5">
          <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-2">Total revenue</div>
          <div className="font-display text-3xl font-bold text-accent2">\${totalRevenue.toFixed(2)}</div>
        </div>
        <div className="bg-white border border-border rounded-xl p-5">
          <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-2">Total GB sold</div>
          <div className="font-display text-3xl font-bold text-accent">{totalGb.toFixed(1)} GB</div>
        </div>
        <div className="bg-white border border-border rounded-xl p-5">
          <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-2">Paid orders</div>
          <div className="font-display text-3xl font-bold text-ink">{paid.length}</div>
        </div>
      </div>
      <div className="bg-white border border-border rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-surface">
              {['Date', 'User', 'GB', 'Amount', 'Status'].map(h => (
                <th key={h} className="text-left px-6 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {orders?.map((o, i) => {
              const profile = o.user_id ? profileMap[o.user_id] : null
              return (
                <tr key={o.id} className="border-b border-border hover:bg-surface">
                  <td className="px-6 py-4 text-xs font-mono text-muted">{new Date(o.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                  <td className="px-6 py-4">
                    <div className="text-sm text-ink">{profile?.full_name || 'Deleted user'}</div>
                    <div className="text-xs font-mono text-muted">{profile?.email || '-'}</div>
                  </td>
                  <td className="px-6 py-4 font-mono text-sm font-medium text-ink">{o.gb_amount} GB</td>
                  <td className="px-6 py-4 font-mono text-sm text-ink">\${o.amount_usd}</td>
                  <td className="px-6 py-4">
                    <span className={\`text-[10px] font-mono px-2.5 py-1 rounded-full \${o.payment_status === 'paid' ? 'bg-accent2-light text-accent2' : o.payment_status === 'pending' ? 'bg-yellow-50 text-yellow-600' : 'bg-red-50 text-red-400'}\`}>
                      {o.payment_status}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}`, 'utf8')

writeFileSync('gp/app/admin/resellers/page.tsx', `import { createAdminClient } from '@/lib/supabase/server'
import AdminResellerActions from '@/components/admin/AdminResellerActions'

export default async function AdminResellersPage() {
  const supabase = await createAdminClient()
  const [{ data: resellers }, { data: applicants }] = await Promise.all([
    supabase.from('profiles').select('*').eq('role', 'reseller').order('created_at', { ascending: false }),
    supabase.from('profiles').select('*').eq('role', 'user').eq('reseller_status', 'pending').order('created_at', { ascending: false }),
  ])

  const resellerIds = resellers?.map(r => r.id) ?? []
  const { data: bwAccounts } = resellerIds.length > 0
    ? await supabase.from('bandwidth_accounts').select('user_id, total_gb, used_gb').in('user_id', resellerIds)
    : { data: [] }
  const bwMap = Object.fromEntries((bwAccounts ?? []).map(b => [b.user_id, b]))

  return (
    <div className="max-w-5xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">Resellers</h1>
        <p className="text-muted text-sm mt-1">Manage reseller accounts and applications</p>
      </div>
      {applicants && applicants.length > 0 && (
        <div className="bg-yellow-50 border border-yellow-100 rounded-xl p-5 mb-6">
          <div className="font-medium text-yellow-800 text-sm mb-3">{applicants.length} pending application{applicants.length > 1 ? 's' : ''}</div>
          <div className="flex flex-col gap-2">
            {applicants.map(a => (
              <div key={a.id} className="flex items-center justify-between bg-white border border-yellow-100 rounded-lg px-4 py-3">
                <div>
                  <div className="text-sm font-medium text-ink">{a.full_name || '-'}</div>
                  <div className="text-xs font-mono text-muted">{a.email}</div>
                </div>
                <AdminResellerActions userId={a.id} action="approve" />
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="bg-white border border-border rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <h2 className="font-display font-bold text-base text-ink">Active resellers ({resellers?.length ?? 0})</h2>
        </div>
        {resellers && resellers.length > 0 ? (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-surface">
                {['Reseller', 'Available GB', 'Total purchased', 'Joined', 'Actions'].map(h => (
                  <th key={h} className="text-left px-6 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {resellers.map((r, i) => {
                const bw = bwMap[r.id]
                const available = (bw?.total_gb ?? 0) - (bw?.used_gb ?? 0)
                return (
                  <tr key={r.id} className="border-b border-border hover:bg-surface">
                    <td className="px-6 py-4">
                      <div className="text-sm font-medium text-ink">{r.full_name || '-'}</div>
                      <div className="text-xs font-mono text-muted">{r.email}</div>
                    </td>
                    <td className="px-6 py-4 font-mono text-sm text-accent">{available.toFixed(1)} GB</td>
                    <td className="px-6 py-4 font-mono text-sm text-ink">{(bw?.total_gb ?? 0).toFixed(1)} GB</td>
                    <td className="px-6 py-4 text-xs font-mono text-muted">{new Date(r.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                    <td className="px-6 py-4"><AdminResellerActions userId={r.id} action="suspend" /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <div className="text-center py-14 text-muted text-sm font-light">No resellers yet.</div>
        )}
      </div>
    </div>
  )
}`, 'utf8')

console.log('Done')