import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/server'
import AdminPager, { parsePage } from '@/components/admin/AdminPager'
import AdminSupportActions from '@/components/admin/AdminSupportActions'

const PAGE_SIZE = 25
const STATUSES = ['open', 'resolved'] as const

// Reports users send from "Report an issue". They used to exist only as an
// email: nothing in the panel listed them, and there was no way to mark one
// handled.
export default async function AdminSupportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const page = parsePage(sp.page)
  const status = typeof sp.status === 'string' && (STATUSES as readonly string[]).includes(sp.status) ? sp.status : 'open'

  const supabase = await createAdminClient()
  const from = (page - 1) * PAGE_SIZE
  const [{ data: reports, count, error }, { count: openCount }, { count: resolvedCount }] = await Promise.all([
    supabase.from('support_reports')
      .select('id, user_id, email, page_url, message, status, created_at, resolved_at, admin_note', { count: 'exact' })
      .eq('status', status)
      .order('created_at', { ascending: status === 'open' }) // oldest unresolved first
      .range(from, from + PAGE_SIZE - 1),
    supabase.from('support_reports').select('*', { count: 'exact', head: true }).eq('status', 'open'),
    supabase.from('support_reports').select('*', { count: 'exact', head: true }).eq('status', 'resolved'),
  ])

  // What the customer was told (migration 0073). A failure here only hides the thread.
  const reportIds = (reports ?? []).map((r: any) => r.id)
  const { data: replyRows } = reportIds.length
    ? await supabase.from('support_report_replies')
        .select('report_id, message, created_at, admin:admin_id(email)').in('report_id', reportIds).order('created_at', { ascending: true })
    : { data: [] as any[] }
  const repliesByReport = new Map<string, any[]>()
  for (const x of (replyRows ?? []) as any[]) {
    const list = repliesByReport.get(x.report_id) ?? []
    list.push(x); repliesByReport.set(x.report_id, list)
  }

  const chip = (on: boolean) => `text-xs font-mono px-3 py-1.5 rounded-full border transition-all ${on ? 'bg-ink text-white border-ink' : 'border-border text-ink2 hover:border-ink2'}`

  return (
    <div className="max-w-5xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">Support reports</h1>
        <p className="text-muted text-sm mt-1">Issues customers sent from the dashboard. Oldest unresolved first.</p>
      </div>

      <div className="flex gap-2 mb-4">
        <Link href="/admin/support?status=open" className={chip(status === 'open')}>{openCount ?? 0} open</Link>
        <Link href="/admin/support?status=resolved" className={chip(status === 'resolved')}>{resolvedCount ?? 0} resolved</Link>
      </div>

      {error ? (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl p-5">Couldn&apos;t load reports.</div>
      ) : (reports ?? []).length === 0 ? (
        <div className="bg-white border border-border rounded-xl p-12 text-center text-muted text-sm font-light">
          {status === 'open' ? 'Nothing waiting — inbox zero.' : 'No resolved reports yet.'}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {(reports ?? []).map((r: any) => (
            <div key={r.id} className="bg-white border border-border rounded-xl p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-xs font-mono text-muted">
                    {r.user_id
                      ? <Link href={`/admin/users/${r.user_id}`} className="hover:text-accent">{r.email}</Link>
                      : r.email}
                    <span> · {new Date(r.created_at).toLocaleString('en-GB')}</span>
                  </div>
                  {r.page_url && <div className="text-[11px] font-mono text-muted mt-0.5 break-all">on {r.page_url}</div>}
                </div>
                <AdminSupportActions reportId={r.id} status={r.status} />
              </div>
              <p className="text-sm text-ink mt-3 whitespace-pre-wrap break-words">{r.message}</p>
              {(repliesByReport.get(r.id) ?? []).map((x: any, i: number) => (
                <div key={i} className="mt-3 bg-surface border border-border rounded-lg px-3 py-2">
                  <div className="text-[10px] font-mono text-muted mb-0.5">Sent to customer · {new Date(x.created_at).toLocaleString('en-GB')} · {x.admin?.email ?? 'admin'}</div>
                  <p className="text-xs text-ink whitespace-pre-wrap break-words">{x.message}</p>
                </div>
              ))}
              {r.status === 'resolved' && (
                <div className="text-[11px] font-mono text-muted mt-3">
                  Resolved {r.resolved_at ? new Date(r.resolved_at).toLocaleString('en-GB') : ''}{r.admin_note ? ` — ${r.admin_note}` : ''}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <AdminPager basePath="/admin/support" page={page} pageSize={PAGE_SIZE} total={count ?? 0} params={{ status }} />
    </div>
  )
}
