import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/server'
import AdminUserControls from '@/components/admin/AdminUserControls'
import AdminSyncUsageButton from '@/components/admin/AdminSyncUsageButton'
import AdminQueryError from '@/components/admin/AdminQueryError'
import AdminPager, { parsePage, cleanSearch } from '@/components/admin/AdminPager'
import { formatGb } from '@/lib/format'

const PAGE_SIZE = 50
const ROLES = ['user', 'reseller', 'admin']
// Quick filters for the accounts that need a decision.
const STATUSES: Record<string, string> = {
  suspended: 'Suspended',
  pending: 'Has a pending request',
  no2fa: 'Admin / reseller without 2FA',
  hold: 'On payment hold',
}

export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const page = parsePage(sp.page)
  const q = cleanSearch(sp.q)
  const role = typeof sp.role === 'string' && ROLES.includes(sp.role) ? sp.role : ''
  const status = typeof sp.status === 'string' && sp.status in STATUSES ? sp.status : ''
  const sort = sp.sort === 'oldest' ? 'oldest' : 'newest'

  const supabase = await createAdminClient()

  // Soft-deleted accounts stay as '[deleted]' tombstones and are excluded.
  // Paged and searchable: this used to fetch every profile in one request
  // (silently cut off at 1000 rows) and then hand the whole id list to an
  // `.in()` filter, whose URL gets too long long before that.
  let query = supabase
    .from('profiles')
    .select('id, email, full_name, role, is_suspended, api_access, mfa_enabled, created_at', { count: 'exact' })
    .eq('is_deleted', false)
  if (role) query = query.eq('role', role)
  if (status === 'suspended') query = query.eq('is_suspended', true)
  else if (status === 'pending') query = query.or('reseller_status.eq.pending,affiliate_status.eq.pending,api_access_status.eq.pending')
  else if (status === 'no2fa') query = query.in('role', ['admin', 'reseller']).eq('mfa_enabled', false)
  if (q) query = query.or(`email.ilike.%${q}%,full_name.ilike.%${q}%`)
  if (status === 'hold') {
    // Holds are rare (a lost dispute or a manual hold), so the id list stays short.
    const { data: holdRows } = await supabase.from('payment_holds').select('user_id').limit(200)
    const ids = (holdRows ?? []).map(h => h.user_id)
    query = query.in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000'])
  }
  const from = (page - 1) * PAGE_SIZE
  const { data: users, count, error: listErr } = await query.order('created_at', { ascending: sort === 'oldest' }).range(from, from + PAGE_SIZE - 1)

  const userIds = users?.map(u => u.id) ?? []
  const { data: bwAccounts } = userIds.length > 0
    ? await supabase.from('bandwidth_accounts').select('user_id, available_gb, total_gb, used_gb').in('user_id', userIds)
    : { data: [] }
  const { data: heldRows } = userIds.length > 0
    ? await supabase.from('payment_holds').select('user_id').in('user_id', userIds)
    : { data: [] as { user_id: string }[] }
  const heldIds = new Set((heldRows ?? []).map(h => h.user_id))
  const bwMap = Object.fromEntries((bwAccounts ?? []).map(b => [b.user_id, b]))

  return (
    <div className="max-w-6xl">
      {listErr && <AdminQueryError what="the user list" />}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="font-display font-bold text-2xl text-ink">All Users</h1>
          <p className="text-muted text-sm mt-1">{(count ?? 0).toLocaleString()} {q || role || status ? 'matching' : 'registered'} accounts</p>
        </div>
        <AdminSyncUsageButton label="Sync all usage now" />
      </div>

      <form method="get" className="flex flex-wrap gap-2 mb-5">
        <input name="q" defaultValue={q} placeholder="Search email or name…"
          className="w-64 bg-white border border-border px-3 py-2 rounded-lg text-sm focus:outline-none focus:border-accent" />
        <select name="role" defaultValue={role} className="bg-white border border-border px-3 py-2 rounded-lg text-sm">
          <option value="">All roles</option>
          {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        <select name="status" defaultValue={status} className="bg-white border border-border px-3 py-2 rounded-lg text-sm">
          <option value="">Any status</option>
          {Object.entries(STATUSES).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <select name="sort" defaultValue={sort} className="bg-white border border-border px-3 py-2 rounded-lg text-sm">
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
        <button className="text-xs font-mono px-4 py-2 rounded-lg border border-border text-ink2 hover:border-ink2">Filter</button>
        {(q || role || status || sort === 'oldest') && <Link href="/admin/users" className="text-xs font-mono px-4 py-2 text-muted hover:text-ink">Clear</Link>}
      </form>

      <div className="bg-white border border-border rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
                        <tr className="border-b border-border bg-surface">
              {['User', 'Role', 'Total', 'Used', 'Available', 'Status', 'API', 'Joined', 'Actions'].map(h => (
                <th key={h} className="text-left px-5 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users?.map((u, i) => {
              const bw = bwMap[u.id]
              return (
                <tr key={u.id} className={`${i < users.length - 1 ? 'border-b border-border' : ''} hover:bg-surface transition-colors`}>
                  <td className="px-5 py-3.5">
                    <Link href={`/admin/users/${u.id}`} className="text-sm font-medium text-ink hover:text-accent transition-colors">
                      {u.full_name || '—'}
                    </Link>
                    <div className="text-xs font-mono text-muted">{u.email}</div>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={`text-[10px] font-mono px-2.5 py-1 rounded-full ${
                      u.role === 'admin' ? 'bg-accent-light text-accent' :
                      u.role === 'reseller' ? 'bg-accent2-light text-accent2' :
                      'bg-surface text-muted border border-border'
                    }`}>{u.role}</span>
                    {/* MFA is optional (recommended) — still flag privileged accounts
                        that haven't enabled it, so it's visible in the list and
                        not only on each user's detail page. */}
                    {(u.role === 'admin' || u.role === 'reseller') && !u.mfa_enabled && (
                      <span className="ml-1.5 text-[10px] font-mono px-2 py-1 rounded-full bg-amber-50 text-amber-700" title="Two-factor authentication is not enabled (recommended)">
                        no 2FA
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3.5 font-mono text-sm text-ink">{formatGb(bw?.total_gb)} GB</td>
                  <td className="px-5 py-3.5 font-mono text-sm text-ink">{formatGb(bw?.used_gb)} GB</td>
                  <td className="px-5 py-3.5 font-mono text-sm text-ink">{formatGb(bw?.available_gb)} GB</td>
                  <td className="px-5 py-3.5">
                    {u.is_suspended ? <span className="text-[10px] font-mono bg-red-50 text-red-500 px-2.5 py-1 rounded-full">Suspended</span> : <span className="text-[10px] font-mono bg-accent2-light text-accent2 px-2.5 py-1 rounded-full">Active</span>}
                    {heldIds.has(u.id) && <span className="ml-1.5 text-[10px] font-mono bg-amber-50 text-amber-700 px-2 py-1 rounded-full" title="New purchases are blocked for this account">hold</span>}
                  </td>
                  <td className="px-5 py-3.5">
                    {u.role === 'reseller' ? (u.api_access ? <span className="text-[10px] font-mono bg-accent-light text-accent px-2.5 py-1 rounded-full">Enabled</span> : <span className="text-[10px] font-mono bg-surface text-muted border border-border px-2.5 py-1 rounded-full">Off</span>) : <span className="text-[10px] text-muted">—</span>}
                  </td>
                  <td className="px-5 py-3.5 text-xs font-mono text-muted">
                    {new Date(u.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </td>
                  <td className="px-5 py-3.5">
                    <AdminUserControls user={{ id: u.id, email: u.email, role: u.role, is_suspended: u.is_suspended, api_access: u.api_access, mfa_enabled: u.mfa_enabled }} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <AdminPager basePath="/admin/users" page={page} pageSize={PAGE_SIZE} total={count ?? 0} params={{ q, role, status, sort: sort === 'oldest' ? 'oldest' : '' }} />
    </div>
  )
}
