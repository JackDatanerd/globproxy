import { createAdminClient } from '@/lib/supabase/server'
import AdminResellerActions from '@/components/admin/AdminResellerActions'
import AdminApiAccessActions from '@/components/admin/AdminApiAccessActions'
import AdminPager, { parsePage, cleanSearch } from '@/components/admin/AdminPager'
import { formatGb } from '@/lib/format'

const PAGE_SIZE = 50
const LIST_CAP = 100 // pending applications shown at once

export default async function AdminResellersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const page = parsePage(sp.page)
  const q = cleanSearch(sp.q)
  const from = (page - 1) * PAGE_SIZE
  const supabase = await createAdminClient()
  // Deleted accounts keep role = 'reseller' on their '[deleted]' tombstone
  // row, so every list here excludes is_deleted — they used to show up as
  // "active resellers" (and as pending applicants). The active list is paged and
  // searchable (it used to be unbounded, silently cut off at 1000 rows) and the
  // pending lists are capped with their real totals shown.
  let resellerQuery = supabase.from('profiles')
    .select('id, full_name, email, is_suspended, created_at', { count: 'exact' })
    .eq('role', 'reseller').eq('is_deleted', false)
  if (q) resellerQuery = resellerQuery.or(`email.ilike.%${q}%,full_name.ilike.%${q}%`)
  const [{ data: resellers, count: resellerCount }, { data: applicants, count: applicantCount }, { data: apiApplicants, count: apiApplicantCount }] = await Promise.all([
    resellerQuery.order('created_at', { ascending: false }).range(from, from + PAGE_SIZE - 1),
    supabase.from('profiles').select('id, full_name, email, reseller_application', { count: 'exact' }).eq('role', 'user').eq('reseller_status', 'pending').eq('is_deleted', false).order('created_at', { ascending: false }).limit(LIST_CAP),
    supabase.from('profiles').select('id, full_name, email, api_access_application', { count: 'exact' }).eq('role', 'reseller').eq('api_access_status', 'pending').eq('is_deleted', false).order('created_at', { ascending: false }).limit(LIST_CAP),
  ])

  const resellerIds = resellers?.map(r => r.id) ?? []
  const { data: bwAccounts } = resellerIds.length > 0
    ? await supabase.from('bandwidth_accounts').select('user_id, total_gb, used_gb, allocated_gb, available_gb').in('user_id', resellerIds)
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
              {applicantCount ?? applicants.length}
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

      {/* Pending API access requests */}
      {apiApplicants && apiApplicants.length > 0 && (
        <div className="mb-8">
          <h2 className="font-display font-bold text-base text-ink mb-3">
            Pending API access requests
            <span className="ml-2 text-xs font-mono bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full">
              {apiApplicantCount ?? apiApplicants.length}
            </span>
          </h2>
          <div className="flex flex-col gap-3">
            {apiApplicants.map(a => {
              const app = a.api_access_application as any
              return (
                <div key={a.id} className="bg-white border border-border rounded-xl p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-3">
                        <div className="text-sm font-medium text-ink">{a.full_name || '—'}</div>
                        <span className="text-[10px] font-mono bg-yellow-50 text-yellow-600 px-2 py-0.5 rounded-full">pending</span>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <div className="flex gap-2">
                          <span className="text-[10px] font-mono text-muted uppercase tracking-wider w-20 flex-shrink-0">Email</span>
                          <span className="text-xs text-ink">{a.email}</span>
                        </div>
                        <div className="flex gap-2">
                          <span className="text-[10px] font-mono text-muted uppercase tracking-wider w-20 flex-shrink-0">Use case</span>
                          <span className="text-xs text-ink">{app?.use_case || '—'}</span>
                        </div>
                        {typeof app?.website_url === 'string' && /^https?:\/\//i.test(app.website_url) && (
                          <div className="flex gap-2">
                            <span className="text-[10px] font-mono text-muted uppercase tracking-wider w-20 flex-shrink-0">Website</span>
                            <a href={app.website_url} target="_blank" rel="noopener noreferrer" className="text-xs text-accent hover:underline">{app.website_url}</a>
                          </div>
                        )}
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
                    <div className="flex gap-2 flex-shrink-0">
                      <AdminApiAccessActions userId={a.id} action="approve" />
                      <AdminApiAccessActions userId={a.id} action="reject" />
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
        <div className="px-6 py-4 border-b border-border flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display font-bold text-base text-ink">Resellers ({(resellerCount ?? 0).toLocaleString()}{q ? ' matching' : ''})</h2>
          <form method="get" className="flex items-center gap-2">
            <input name="q" defaultValue={q} placeholder="Search email or name…"
              className="w-56 bg-white border border-border px-3 py-1.5 rounded-lg text-xs focus:outline-none focus:border-accent" />
            <button className="text-xs font-mono px-3 py-1.5 rounded-lg border border-border text-ink2 hover:border-ink2">Search</button>
          </form>
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
                // Previously computed as total_gb - used_gb, which ignored GB
                // already committed to clients (allocated_gb, migration 0004) —
                // this made a reseller's dashboard-visible "available" balance
                // look bigger than what they can actually allocate. available_gb
                // is the DB-computed generated column, always correct.
                const available = bw?.available_gb ?? ((bw?.total_gb ?? 0) - (bw?.used_gb ?? 0))
                return (
                  <tr key={r.id} className={`${i < (resellers?.length ?? 0) - 1 ? 'border-b border-border' : ''} hover:bg-surface`}>
                    <td className="px-6 py-4">
                      <div className="text-sm font-medium text-ink">
                        {r.full_name || '—'}
                        {r.is_suspended && <span className="ml-2 text-[10px] font-mono bg-red-50 text-red-500 px-2 py-0.5 rounded-full">Suspended</span>}
                      </div>
                      <div className="text-xs font-mono text-muted">{r.email}</div>
                    </td>
                    <td className="px-6 py-4 font-mono text-sm text-accent">{formatGb(Math.max(0, available))} GB</td>
                    <td className="px-6 py-4 font-mono text-sm text-ink">{formatGb(bw?.total_gb)} GB</td>
                    <td className="px-6 py-4 text-xs font-mono text-muted">
                      {new Date(r.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                    </td>
                    <td className="px-6 py-4">
                      <AdminResellerActions userId={r.id} action={r.is_suspended ? 'reinstate' : 'suspend'} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <div className="text-center py-14 text-muted text-sm font-light">{q ? 'No resellers match.' : 'No active resellers yet.'}</div>
        )}
      </div>
      <AdminPager basePath="/admin/resellers" page={page} pageSize={PAGE_SIZE} total={resellerCount ?? 0} params={{ q }} />
    </div>
  )
}
