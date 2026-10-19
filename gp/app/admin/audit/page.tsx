import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/server'
import AdminPager, { parsePage, cleanSearch } from '@/components/admin/AdminPager'

const PAGE_SIZE = 50

// Append-only record of everything admins do (admin_audit_log, migration
// 0043): suspensions, deletions, role/API-access changes, MFA resets,
// approvals, payouts, Verified Operator changes… plus system rows such as
// a refund that arrived after its affiliate commission had already been
// paid out (needs manual follow-up).
export default async function AdminAuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const page = parsePage(sp.page)
  const q = cleanSearch(sp.q) // matches the action name, e.g. "payout" or "user.suspend"

  const supabase = await createAdminClient()
  let query = supabase
    .from('admin_audit_log')
    .select('id, action, target_ref, details, created_at, admin:admin_id(email), target:target_user_id(email)', { count: 'exact' })
  if (q) query = query.ilike('action', `%${q}%`)
  const from = (page - 1) * PAGE_SIZE
  const { data: rows, count, error } = await query.order('created_at', { ascending: false }).range(from, from + PAGE_SIZE - 1)

  return (
    <div className="max-w-6xl">
      <div className="mb-6">
        <h1 className="font-display font-bold text-2xl text-ink">Audit log</h1>
        <p className="text-muted text-sm mt-1">Who did what, to whom. Rows are append-only.</p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-600 text-xs font-mono rounded-xl px-4 py-3 mb-6">
          Could not load the audit log — has migration 0043_admin_hardening.sql been run?
        </div>
      )}

      <form method="get" className="flex gap-2 mb-5">
        <input name="q" defaultValue={q} placeholder="Filter by action (e.g. payout, user.suspend)…"
          className="w-72 bg-white border border-border px-3 py-2 rounded-lg text-sm focus:outline-none focus:border-accent" />
        <button className="text-xs font-mono px-4 py-2 rounded-lg border border-border text-ink2 hover:border-ink2">Filter</button>
        {q && <Link href="/admin/audit" className="text-xs font-mono px-4 py-2 text-muted hover:text-ink">Clear</Link>}
      </form>

      <div className="bg-white border border-border rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-surface">
              {['When', 'Admin', 'Action', 'Target', 'Details'].map(h => (
                <th key={h} className="text-left px-5 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).length === 0 ? (
              <tr><td colSpan={5} className="px-5 py-12 text-center text-sm text-muted">{error ? '—' : 'Nothing recorded yet.'}</td></tr>
            ) : (rows ?? []).map((r: any, i: number) => (
              <tr key={r.id} className={`${i < (rows?.length ?? 0) - 1 ? 'border-b border-border' : ''} hover:bg-surface align-top`}>
                <td className="px-5 py-3 text-xs font-mono text-muted whitespace-nowrap">{new Date(r.created_at).toLocaleString('en-GB')}</td>
                <td className="px-5 py-3 text-xs font-mono text-ink">{r.admin?.email ?? <span className="text-muted">system</span>}</td>
                <td className="px-5 py-3 text-sm font-mono text-ink">{r.action}</td>
                <td className="px-5 py-3 text-xs font-mono text-muted break-all">{r.target?.email ?? r.target_ref ?? '—'}</td>
                <td className="px-5 py-3 text-[11px] font-mono text-muted break-all max-w-xs">
                  {r.details && Object.keys(r.details).length > 0 ? JSON.stringify(r.details) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <AdminPager basePath="/admin/audit" page={page} pageSize={PAGE_SIZE} total={count ?? 0} params={{ q }} />
    </div>
  )
}
