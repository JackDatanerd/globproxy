import { createAdminClient } from '@/lib/supabase/server'

export default async function AdminCredentialsPage() {
  const supabase = await createAdminClient()

  // Fetch credentials without FK-hinted join — more resilient after migrations
  const { data: creds } = await supabase
    .from('proxy_credentials')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200)

  // Previously these were computed from the same 200-row limited `creds`
  // list above — past 200 total credentials, the header count and the
  // active/pending badges would all silently undercount. Exact-count
  // queries here are correct at any scale.
  const [{ count: totalCount }, { count: active }, { count: pending }] = await Promise.all([
    supabase.from('proxy_credentials').select('*', { count: 'exact', head: true }),
    supabase.from('proxy_credentials').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('proxy_credentials').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
  ])

  // Fetch emails separately to avoid join failures from FK renames
  const userIds = Array.from(new Set((creds ?? []).map(c => c.user_id).filter(Boolean)))
  let emailMap: Record<string, string> = {}
  if (userIds.length > 0) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, email')
      .in('id', userIds)
    for (const p of profiles ?? []) {
      emailMap[p.id] = p.email
    }
  }

  return (
    <div className="max-w-6xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">All Credentials</h1>
        <p className="text-muted text-sm mt-1">{totalCount ?? 0} total proxy sessions across all users</p>
      </div>

      <div className="flex gap-3 mb-6">
        <span className="text-xs font-mono bg-accent2-light text-accent2 px-3 py-1.5 rounded-full">{active ?? 0} active</span>
        <span className="text-xs font-mono bg-yellow-50 text-yellow-600 px-3 py-1.5 rounded-full">{pending ?? 0} pending</span>
      </div>

      <div className="bg-white border border-border rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-surface">
              {['User', 'Label', 'Country', 'Allocated', 'Used', 'Status', 'Created'].map(h => (
                <th key={h} className="text-left px-5 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(creds ?? []).length === 0 ? (
              <tr>
                <td colSpan={7} className="px-5 py-12 text-center text-sm text-muted">
                  No credentials yet.
                </td>
              </tr>
            ) : (creds ?? []).map((c, i) => (
              <tr key={c.id} className={`${i < (creds?.length ?? 0) - 1 ? 'border-b border-border' : ''} hover:bg-surface`}>
                <td className="px-5 py-3 text-xs font-mono text-muted">
                  {emailMap[c.user_id] ?? '—'}
                </td>
                <td className="px-5 py-3 text-sm text-ink">{c.label || '—'}</td>
                <td className="px-5 py-3 text-xs font-mono text-muted">{c.country || 'Any'}</td>
                <td className="px-5 py-3 font-mono text-sm text-ink">{Number(c.gb_allocated ?? 0).toFixed(2)}</td>
                <td className="px-5 py-3 font-mono text-sm text-ink">{Number(c.gb_used ?? 0).toFixed(2)}</td>
                <td className="px-5 py-3">
                  <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full ${
                    c.status === 'active' ? 'bg-accent2-light text-accent2' :
                    c.status === 'pending' ? 'bg-yellow-50 text-yellow-600' :
                    'bg-red-50 text-red-400'
                  }`}>{c.status}</span>
                </td>
                <td className="px-5 py-3 text-xs font-mono text-muted">
                  {new Date(c.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
