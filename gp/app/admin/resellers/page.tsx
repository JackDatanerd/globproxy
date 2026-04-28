import { createAdminClient } from '@/lib/supabase/server'
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
}