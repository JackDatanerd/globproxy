import { createAdminClient } from '@/lib/supabase/server'
import AdminPager, { parsePage, cleanSearch } from '@/components/admin/AdminPager'
import { AdminBanForm, AdminUnbanButton } from '@/components/admin/AdminBanControls'

const PAGE_SIZE = 50

// Addresses blocked from registering (signup checks them, normalised for
// case and +tags). Until now the list could only be edited with SQL.
export default async function AdminBansPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const page = parsePage(sp.page)
  const q = cleanSearch(sp.q)

  const supabase = await createAdminClient()
  const from = (page - 1) * PAGE_SIZE
  let query = supabase.from('banned_emails')
    .select('id, email, reason, banned_at, banner:banned_by(email)', { count: 'exact' })
  if (q) query = query.ilike('email', `%${q}%`)
  const { data: bans, count, error } = await query.order('banned_at', { ascending: false }).range(from, from + PAGE_SIZE - 1)

  return (
    <div className="max-w-5xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">Banned emails</h1>
        <p className="text-muted text-sm mt-1">
          Blocked from registering. Matching ignores letter case and +tags, so banning one form blocks them all.
          Banning does not touch an account that already exists — suspend it from its user page.
        </p>
      </div>

      <AdminBanForm />

      <form method="get" className="flex gap-2 mb-4">
        <input name="q" defaultValue={q} placeholder="Search banned addresses…"
          className="w-72 bg-white border border-border px-3 py-1.5 rounded-lg text-sm focus:outline-none focus:border-accent" />
        <button className="text-xs font-mono px-3 py-1.5 rounded-lg border border-border text-ink2 hover:border-ink2">Search</button>
      </form>

      {error ? (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl p-5">Couldn&apos;t load the ban list.</div>
      ) : (
        <div className="bg-white border border-border rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-surface">
                {['Address', 'Reason', 'Banned', 'By', ''].map(h => (
                  <th key={h} className="text-left px-5 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(bans ?? []).length === 0 ? (
                <tr><td colSpan={5} className="px-5 py-12 text-center text-sm text-muted">{q ? 'No banned address matches.' : 'No banned addresses.'}</td></tr>
              ) : (bans as any[]).map((b, i) => (
                <tr key={b.id} className={`${i < bans!.length - 1 ? 'border-b border-border' : ''} hover:bg-surface`}>
                  <td className="px-5 py-3 text-xs font-mono text-ink">{b.email}</td>
                  <td className="px-5 py-3 text-xs text-muted max-w-[260px]">{b.reason || '—'}</td>
                  <td className="px-5 py-3 text-xs font-mono text-muted whitespace-nowrap">
                    {b.banned_at ? new Date(b.banned_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
                  </td>
                  <td className="px-5 py-3 text-xs text-muted">{b.banner?.email ?? '—'}</td>
                  <td className="px-5 py-3 text-right"><AdminUnbanButton banId={b.id} email={b.email} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <AdminPager basePath="/admin/bans" page={page} pageSize={PAGE_SIZE} total={count ?? 0} params={{ q }} />
    </div>
  )
}
