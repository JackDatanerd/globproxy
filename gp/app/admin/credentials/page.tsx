import { suspendedReasonLabel } from '@/lib/suspendReason'
import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/server'
import AdminQueryError from '@/components/admin/AdminQueryError'
import AdminPager, { parsePage, cleanSearch } from '@/components/admin/AdminPager'
import AdminCredentialAction from '@/components/admin/AdminCredentialAction'
import AdminCredentialRemediate from '@/components/admin/AdminCredentialRemediate'
import { formatGb } from '@/lib/format'
import { readOrphanReport } from '@/lib/usageSync'

const PAGE_SIZE = 50
const SEARCH_CAP = 200
const STATUSES = ['active', 'pending', 'suspended'] as const

export default async function AdminCredentialsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const page = parsePage(sp.page)
  const q = cleanSearch(sp.q)
  const status = typeof sp.status === 'string' && (STATUSES as readonly string[]).includes(sp.status) ? sp.status : ''
  // Deleted accounts' credentials are tombstones (suspended_reason = 'deleted',
  // migration 0052). They used to be listed as ordinary suspended credentials
  // with an Enable button that could only ever fail, and inflated the counts.
  const showDeleted = sp.deleted === '1'

  const supabase = await createAdminClient()

  // Owner search resolves to user ids first.
  let searchIds: string[] | null = null
  let searchCapped = false
  if (q) {
    const { data: matches } = await supabase
      .from('profiles')
      .select('id')
      .or(`email.ilike.%${q}%,full_name.ilike.%${q}%`)
      .limit(SEARCH_CAP + 1)
    searchIds = (matches ?? []).map(m => m.id)
    // The id list goes back into the query as ?in.(…), so it cannot grow without bound. Past the
    // cap the results used to be silently incomplete; now the page says so.
    if (searchIds.length > SEARCH_CAP) { searchCapped = true; searchIds = searchIds.slice(0, SEARCH_CAP) }
  }

  // Fetch credentials without an FK-hinted join — more resilient after migrations.
  const visible = <T extends { or: (f: string) => T }>(q: T): T => showDeleted ? q : q.or('suspended_reason.is.null,suspended_reason.neq.deleted')
  let query = visible(supabase.from('proxy_credentials').select('*', { count: 'exact' }))
  if (status) query = query.eq('status', status)
  if (searchIds) query = searchIds.length ? query.in('user_id', searchIds) : query.in('user_id', ['00000000-0000-0000-0000-000000000000'])
  const from = (page - 1) * PAGE_SIZE
  const { data: creds, count, error: listErr } = await query.order('created_at', { ascending: false }).range(from, from + PAGE_SIZE - 1)

  const [{ count: totalCount }, { count: active }, { count: pending }, { count: suspended }] = await Promise.all([
    visible(supabase.from('proxy_credentials').select('*', { count: 'exact', head: true })),
    visible(supabase.from('proxy_credentials').select('*', { count: 'exact', head: true }).eq('status', 'active')),
    visible(supabase.from('proxy_credentials').select('*', { count: 'exact', head: true }).eq('status', 'pending')),
    visible(supabase.from('proxy_credentials').select('*', { count: 'exact', head: true }).eq('status', 'suspended')),
  ])

  // Sessions whose proxy vanished upstream, and untracked supplier-side proxies (both flagged
  // by the usage sync, which used to e-mail the admin and point at a panel that had no action).
  const { data: missingRows } = await supabase.from('proxy_credentials')
    .select('id, user_id, label, gb_allocated, gb_used, upstream_missing_since, created_by')
    .in('status', ['active', 'suspended']).not('upstream_missing_since', 'is', null)
    .order('upstream_missing_since', { ascending: true }).limit(50)
  const orphans = await readOrphanReport(supabase).catch(() => null)

  const userIds = Array.from(new Set((creds ?? []).map(c => c.user_id).filter(Boolean)))
  let emailMap: Record<string, string> = {}
  if (userIds.length > 0) {
    const { data: profiles } = await supabase.from('profiles').select('id, email').in('id', userIds)
    for (const p of profiles ?? []) emailMap[p.id] = p.email
  }

  const missingMap = new Map((missingRows ?? []).map((m: any) => [m.id, m]))

  const chip = (on: boolean, cls: string) => `text-xs font-mono px-3 py-1.5 rounded-full transition-all ${cls} ${on ? 'ring-2 ring-ink/30' : ''}`
  const hrefFor = (s: string) => {
    const p = new URLSearchParams()
    if (q) p.set('q', q)
    if (s) p.set('status', s)
    if (showDeleted) p.set('deleted', '1')
    const qs = p.toString()
    return qs ? `/admin/credentials?${qs}` : '/admin/credentials'
  }

  return (
    <div className="max-w-6xl">
      {listErr && <AdminQueryError what="credentials" />}
      {searchCapped && (
        <div className="mb-4 text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-4 py-2">
          “{q}” matches more than {SEARCH_CAP} accounts, so only the first {SEARCH_CAP} are searched and this list is incomplete. Use a longer part of the email or name.
        </div>
      )}
      {(missingRows ?? []).length > 0 && (
        <div className="mb-4 text-xs bg-red-50 border border-red-200 text-red-800 rounded-lg px-4 py-3">
          <strong>{(missingRows ?? []).length} session(s) (active or paused) have no live proxy behind them.</strong> Their customers cannot connect or resume.
          Use Re-provision or Refund on the flagged rows below (reseller-allocated ones must be handled with the reseller).
          <ul className="mt-1 font-mono text-[11px]">
            {(missingRows ?? []).slice(0, 10).map((m: any) => (
              <li key={m.id}>{m.label || 'Unnamed'} · {formatGb(m.gb_allocated)} · since {new Date(m.upstream_missing_since).toLocaleString('en-GB')}{m.created_by ? ' · reseller-allocated' : ''}</li>
            ))}
          </ul>
        </div>
      )}
      {orphans && (
        <div className="mb-4 text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-4 py-3">
          <strong>{orphans.count} untracked proxy(ies) exist at the provider</strong> with no session behind them (zero-traffic ones are removed automatically after 24h; ones with usage stay for review).
          <div className="mt-1 font-mono text-[11px] break-all">{orphans.ids.slice(0, 20).join(', ')}</div>
        </div>
      )}
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">All Credentials</h1>
        <p className="text-muted text-sm mt-1">{totalCount ?? 0} total proxy sessions across all users</p>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <Link href={hrefFor('')} className={chip(!status, 'bg-surface text-ink2 border border-border')}>{totalCount ?? 0} all</Link>
        <Link href={hrefFor('active')} className={chip(status === 'active', 'bg-accent2-light text-accent2')}>{active ?? 0} active</Link>
        <Link href={hrefFor('pending')} className={chip(status === 'pending', 'bg-yellow-50 text-yellow-600')}>{pending ?? 0} pending</Link>
        <Link href={hrefFor('suspended')} className={chip(status === 'suspended', 'bg-red-50 text-red-400')}>{suspended ?? 0} suspended</Link>
        <Link href={(() => { const p = new URLSearchParams(); if (q) p.set('q', q); if (status) p.set('status', status); if (!showDeleted) p.set('deleted', '1'); const qs = p.toString(); return qs ? `/admin/credentials?${qs}` : '/admin/credentials' })()}
          className="text-xs font-mono text-muted hover:text-ink underline">{showDeleted ? 'Hide' : 'Show'} deleted-account credentials</Link>
        <form method="get" className="ml-auto flex gap-2">
          {status && <input type="hidden" name="status" value={status} />}
          {showDeleted && <input type="hidden" name="deleted" value="1" />}
          <input name="q" defaultValue={q} placeholder="Search owner email or name…"
            className="w-64 bg-white border border-border px-3 py-1.5 rounded-lg text-sm focus:outline-none focus:border-accent" />
          <button className="text-xs font-mono px-3 py-1.5 rounded-lg border border-border text-ink2 hover:border-ink2">Search</button>
        </form>
      </div>

      <div className="bg-white border border-border rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-surface">
              {['User', 'Label', 'Country', 'Allocated', 'Used', 'Status', 'Created', 'Action'].map(h => (
                <th key={h} className="text-left px-5 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(creds ?? []).length === 0 ? (
              <tr><td colSpan={8} className="px-5 py-12 text-center text-sm text-muted">No credentials match.</td></tr>
            ) : (creds ?? []).map((c, i) => (
              <tr key={c.id} className={`${i < (creds?.length ?? 0) - 1 ? 'border-b border-border' : ''} hover:bg-surface`}>
                <td className="px-5 py-3 text-xs font-mono text-muted">
                  <Link href={`/admin/users/${c.user_id}`} className="hover:text-accent">{emailMap[c.user_id] ?? '—'}</Link>
                </td>
                <td className="px-5 py-3 text-sm text-ink">{c.label || '—'}</td>
                <td className="px-5 py-3 text-xs font-mono text-muted">{c.country || 'Any'}</td>
                <td className="px-5 py-3 font-mono text-sm text-ink">{formatGb(c.gb_allocated)}</td>
                <td className="px-5 py-3 font-mono text-sm text-ink">
                  {formatGb(c.gb_used)}
                  {Number(c.gb_allocated) > 0 && Number(c.gb_used) >= Number(c.gb_allocated) && <span className="ml-2 text-[10px] font-mono bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full">exhausted</span>}
                </td>
                <td className="px-5 py-3">
                  <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full ${
                    c.status === 'active' ? 'bg-accent2-light text-accent2' :
                    c.status === 'pending' ? 'bg-yellow-50 text-yellow-600' :
                    'bg-red-50 text-red-400'
                  }`}>{c.status}</span>
                  {c.status === 'suspended' && c.suspended_reason && (
                    <div className="text-[10px] font-mono text-muted mt-1">
                      {suspendedReasonLabel(c.suspended_reason)}
                    </div>
                  )}
                </td>
                <td className="px-5 py-3 text-xs font-mono text-muted">
                  {new Date(c.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
                </td>
                <td className="px-5 py-3">{c.suspended_reason === 'deleted' ? null : c.suspended_reason === 'customer' ? <><span className="text-[10px] font-mono text-muted">only the customer can resume</span>{missingMap.has(c.id) && !c.created_by && <AdminCredentialRemediate credentialId={c.id} />}</> : <><AdminCredentialAction credentialId={c.id} status={c.status} />{missingMap.has(c.id) && !c.created_by && <AdminCredentialRemediate credentialId={c.id} />}</>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <AdminPager basePath="/admin/credentials" page={page} pageSize={PAGE_SIZE} total={count ?? 0} params={{ q, status, deleted: showDeleted ? '1' : '' }} />
    </div>
  )
}
