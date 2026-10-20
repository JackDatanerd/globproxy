import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/server'
import AdminPager, { parsePage, cleanSearch } from '@/components/admin/AdminPager'
import AdminCsvButton from '@/components/admin/AdminCsvButton'
import { parseAuditFilters, resolveWhoIds, applyAuditFilters } from '@/lib/adminAuditFilters'

const PAGE_SIZE = 50

// Append-only record of everything admins do (admin_audit_log, migration
// 0043): suspensions, deletions, role/API-access changes, MFA resets,
// approvals, payouts, Verified Operator changes, refunds, bandwidth
// adjustments… plus system rows such as a refund that arrived after its
// affiliate commission had already been paid out (needs manual follow-up).
export default async function AdminAuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const page = parsePage(sp.page)
  const get = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined)
  const f = parseAuditFilters(get, cleanSearch)
  const anyFilter = !!(f.action || f.user || f.who || f.from || f.to)

  const supabase = await createAdminClient()
  const whoIds = await resolveWhoIds(supabase, f.who)
  const query = applyAuditFilters(
    supabase
      .from('admin_audit_log')
      .select('id, action, target_ref, target_user_id, details, created_at, admin:admin_id(email), target:target_user_id(email)', { count: 'exact' }),
    f, whoIds
  )
  const from = (page - 1) * PAGE_SIZE
  const { data: rows, count, error } = await query.order('created_at', { ascending: false }).range(from, from + PAGE_SIZE - 1)

  const csvParams = new URLSearchParams()
  if (f.action) csvParams.set('q', f.action)
  if (f.user) csvParams.set('user', f.user)
  if (f.who) csvParams.set('who', f.who)
  if (f.from) csvParams.set('from', f.from)
  if (f.to) csvParams.set('to', f.to)

  const inputCls = 'bg-white border border-border px-3 py-2 rounded-lg text-sm focus:outline-none focus:border-accent'

  return (
    <div className="max-w-6xl">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display font-bold text-2xl text-ink">Audit log</h1>
          <p className="text-muted text-sm mt-1">Who did what, to whom. Rows are append-only.</p>
        </div>
        <AdminCsvButton path={`/api/admin/audit-csv${csvParams.toString() ? `?${csvParams}` : ''}`} filename="globproxy-audit-log" />
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-600 text-xs font-mono rounded-xl px-4 py-3 mb-6">
          Could not load the audit log — has migration 0043_admin_hardening.sql been run?
        </div>
      )}

      <form method="get" className="flex flex-wrap gap-2 mb-5 items-center">
        <input name="q" defaultValue={f.action} placeholder="Action (e.g. payout, user.suspend)…" className={`w-60 ${inputCls}`} />
        <input name="who" defaultValue={f.who} placeholder="Admin or user email…" className={`w-52 ${inputCls}`} />
        <label className="text-[10px] font-mono text-muted uppercase tracking-widest">From</label>
        <input name="from" type="date" defaultValue={f.from} className={inputCls} />
        <label className="text-[10px] font-mono text-muted uppercase tracking-widest">To</label>
        <input name="to" type="date" defaultValue={f.to} className={inputCls} />
        {f.user && <input type="hidden" name="user" value={f.user} />}
        <button className="text-xs font-mono px-4 py-2 rounded-lg border border-border text-ink2 hover:border-ink2">Filter</button>
        {anyFilter && <Link href="/admin/audit" className="text-xs font-mono px-4 py-2 text-muted hover:text-ink">Clear</Link>}
      </form>
      {f.user && <p className="text-xs font-mono text-muted mb-4">Showing activity on one account only. <Link href="/admin/audit" className="text-accent hover:underline">Show everything</Link></p>}

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
              <tr><td colSpan={5} className="px-5 py-12 text-center text-sm text-muted">{error ? '—' : anyFilter ? 'Nothing matches those filters.' : 'Nothing recorded yet.'}</td></tr>
            ) : (rows ?? []).map((r: any, i: number) => (
              <tr key={r.id} className={`${i < (rows?.length ?? 0) - 1 ? 'border-b border-border' : ''} hover:bg-surface align-top`}>
                <td className="px-5 py-3 text-xs font-mono text-muted whitespace-nowrap">{new Date(r.created_at).toLocaleString('en-GB')}</td>
                <td className="px-5 py-3 text-xs font-mono text-ink">{r.admin?.email ?? <span className="text-muted">system</span>}</td>
                <td className="px-5 py-3 text-sm font-mono text-ink">{r.action}</td>
                <td className="px-5 py-3 text-xs font-mono text-muted break-all">
                  {r.target_user_id
                    ? <Link href={`/admin/users/${r.target_user_id}`} className="hover:text-accent">{r.target?.email ?? r.target_user_id}</Link>
                    : (r.target_ref ?? '—')}
                </td>
                <td className="px-5 py-3 text-[11px] font-mono text-muted break-all max-w-xs">
                  {r.details && Object.keys(r.details).length > 0 ? JSON.stringify(r.details) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <AdminPager basePath="/admin/audit" page={page} pageSize={PAGE_SIZE} total={count ?? 0} params={{ q: f.action, who: f.who, from: f.from, to: f.to, user: f.user }} />
    </div>
  )
}
