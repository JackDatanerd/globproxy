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

      {/* Pending applications */}
      {applicants && applicants.length > 0 && (
        <div className="mb-8">
          <h2 className="font-display font-bold text-base text-ink mb-3">
            Pending applications
            <span className="ml-2 text-xs font-mono bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full">
              {applicants.length}
            </span>
          </h2>
          <div className="flex flex-col gap-3">
            {applicants.map(a => {
              const app = a.reseller_application as any
              return (
                <div key={a.id} className="bg-white border border-border rounded-xl p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      {/* Identity */}
                      <div className="flex items-center gap-2 mb-3">
                        <div className="text-sm font-medium text-ink">{app?.full_name || a.full_name || '—'}</div>
                        <span className="text-[10px] font-mono bg-yellow-50 text-yellow-600 px-2 py-0.5 rounded-full">pending</span>
                      </div>
                      {/* Application details grid */}
                      <div className="grid grid-cols-2 gap-x-8 gap-y-1.5">
                        <div className="flex gap-2">
                          <span className="text-[10px] font-mono text-muted uppercase tracking-wider w-20 flex-shrink-0">Email</span>
                          <span className="text-xs text-ink">{a.email}</span>
                        </div>
                        <div className="flex gap-2">
                          <span className="text-[10px] font-mono text-muted uppercase tracking-wider w-20 flex-shrink-0">Country</span>
                          <span className="text-xs text-ink">{app?.country || '—'}</span>
                        </div>
                        <div className="flex gap-2">
                          <span className="text-[10px] font-mono text-muted uppercase tracking-wider w-20 flex-shrink-0">Phone</span>
                          <span className="text-xs text-ink">{app?.phone || '—'}</span>
                        </div>
                        <div className="flex gap-2">
                          <span className="text-[10px] font-mono text-muted uppercase tracking-wider w-20 flex-shrink-0">Volume</span>
                          <span className="text-xs text-ink">{app?.monthly_volume || '—'}</span>
                        </div>
                        {app?.applied_at && (
                          <div className="flex gap-2">
                            <span className="text-[10px] font-mono text-muted uppercase tracking-wider w-20 flex-shrink-0">Applied</span>
                            <span className="text-xs text-muted">
                              {new Date(app.applied_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                    {/* Actions */}
                    <div className="flex gap-2 flex-shrink-0">
                      <AdminResellerActions userId={a.id} action="approve" />
                      <AdminResellerActions userId={a.id} action="reject" />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Active resellers */}
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
                  <tr key={r.id} className={`${i < (resellers?.length ?? 0) - 1 ? 'border-b border-border' : ''} hover:bg-surface`}>
                    <td className="px-6 py-4">
                      <div className="text-sm font-medium text-ink">{r.full_name || '—'}</div>
                      <div className="text-xs font-mono text-muted">{r.email}</div>
                    </td>
                    <td className="px-6 py-4 font-mono text-sm text-accent">{Math.max(0, available).toFixed(1)} GB</td>
                    <td className="px-6 py-4 font-mono text-sm text-ink">{(bw?.total_gb ?? 0).toFixed(1)} GB</td>
                    <td className="px-6 py-4 text-xs font-mono text-muted">
                      {new Date(r.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                    </td>
                    <td className="px-6 py-4">
                      <AdminResellerActions userId={r.id} action="suspend" />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <div className="text-center py-14 text-muted text-sm font-light">No active resellers yet.</div>
        )}
      </div>
    </div>
  )
}
