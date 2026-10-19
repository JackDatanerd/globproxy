import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/server'
import AdminPager, { parsePage, cleanSearch } from '@/components/admin/AdminPager'
import AdminCredentialAction from '@/components/admin/AdminCredentialAction'
import { formatGb } from '@/lib/format'

const PAGE_SIZE = 50
const STATUSES = ['active', 'pending', 'suspended'] as const

export default async function AdminCredentialsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const page = parsePage(sp.page)
  const q = cleanSearch(sp.q)
  const status = typeof sp.status === 'string' && (STATUSES as readonly string[]).includes(sp.status) ? sp.status : ''

  const supabase = await createAdminClient()

  // Owner search resolves to user ids first.
  let searchIds: string[] | null = null
  if (q) {
    const { data: matches } = await supabase
      .from('profiles')
      .select('id')
      .or(`email.ilike.%${q}%,full_name.ilike.%${q}%`)
      .limit(200)
    searchIds = (matches ?? []).map(m => m.id)
  }

  // Fetch credentials without an FK-hinted join — more resilient after migrations.
  let query = supabase.from('proxy_credentials').select('*', { count: 'exact' })
  if (status) query = query.eq('status', status)
  if (searchIds) query = searchIds.length ? query.in('user_id', searchIds) : query.in('user_id', ['00000000-0000-0000-0000-000000000000'])
  const from = (page - 1) * PAGE_SIZE
  const { data: creds, count } = await query.order('created_at', { ascending: false }).range(from, from + PAGE_SIZE - 1)

  const [{ count: totalCount }, { count: active }, { count: pending }, { count: suspended }] = await Promise.all([
    supabase.from('proxy_credentials').select('*', { count: 'exact', head: true }),
    supabase.from('proxy_credentials').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('proxy_credentials').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('proxy_credentials').select('*', { count: 'exact', head: true }).eq('status', 'suspended'),
  ])

  const userIds = Array.from(new Set((creds ?? []).map(c => c.user_id).filter(Boolean)))
  let emailMap: Record<string, string> = {}
  if (userIds.length > 0) {
    const { data: profiles } = await supabase.from('profiles').select('id, email').in('id', userIds)
    for (const p of profiles ?? []) emailMap[p.id] = p.email
  }

  const chip = (on: boolean, cls: string) => `text-xs font-mono px-3 py-1.5 rounded-full transition-all ${cls} ${on ? 'ring-2 ring-ink/30' : ''}`
  const hrefFor = (s: string) => {
    const p = new URLSearchParams()
    if (q) p.set('q', q)
    if (s) p.set('status', s)
    const qs = p.toString()
    return qs ? `/admin/credentials?${qs}` : '/admin/credentials'
  }

  return (
    <div className="max-w-6xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">All Credentials</h1>
        <p className="text-muted text-sm mt-1">{totalCount ?? 0} total proxy sessions across all users</p>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <Link href={hrefFor('')} className={chip(!status, 'bg-surface text-ink2 border border-border')}>{totalCount ?? 0} all</Link>
        <Link href={hrefFor('active')} className={chip(status === 'active', 'bg-accent2-light text-accent2')}>{active ?? 0} active</Link>
        <Link href={hrefFor('pending')} className={chip(status === 'pending', 'bg-yellow-50 text-yellow-600')}>{pending ?? 0} pending</Link>
        <Link href={hrefFor('suspended')} className={chip(status === 'suspended', 'bg-red-50 text-red-400')}>{suspended ?? 0} suspended</Link>
        <form method="get" className="ml-auto flex gap-2">
          {status && <input type="hidden" name="status" value={status} />}
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
                <td className="px-5 py-3 font-mono text-sm text-ink">{formatGb(c.gb_used)}</td>
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
                <td className="px-5 py-3"><AdminCredentialAction credentialId={c.id} status={c.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <AdminPager basePath="/admin/credentials" page={page} pageSize={PAGE_SIZE} total={count ?? 0} params={{ q, status }} />
    </div>
  )
}
