import { createClient, createAdminClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ResellerUsersList from '@/components/reseller/ResellerUsersList'
import { formatGb } from '@/lib/format'
import ResellerStockAlert from '@/components/reseller/ResellerStockAlert'
import { parseRosterFilter, parseRosterSort } from '@/lib/reseller'

const PAGE_SIZE = 25

export default async function ResellerUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; filter?: string; sort?: string }>
}) {
  const sp = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const q = (sp.q ?? '').trim().slice(0, 100)
  const filter = parseRosterFilter(sp.filter)
  const sort = parseRosterSort(sp.sort)
  const page = Math.max(1, Math.min(10_000, parseInt(sp.page ?? '1', 10) || 1))

  // The roster comes from a narrow SECURITY DEFINER RPC (id, email, name,
  // totals — nothing else). Resellers used to read clients' whole profile
  // rows through an RLS policy, which exposed payout bank details, M-Pesa
  // numbers and application data (migration 0039 drops that policy). The RPC
  // is scoped to the authenticated reseller here, server-side, and paginated
  // in SQL — the old client-side fold over an unpaginated query silently
  // truncated at 1000 transfers.
  const admin = await createAdminClient()
  const [{ data: bw }, { data: clients }, { data: me }] = await Promise.all([
    supabase.from('bandwidth_accounts').select('available_gb').eq('user_id', user.id).maybeSingle(),
    admin.rpc('reseller_client_roster', {
      p_reseller_id: user.id,
      p_search: q || null,
      p_limit: PAGE_SIZE,
      p_offset: (page - 1) * PAGE_SIZE,
      p_filter: filter,
      p_sort: sort,
    }),
    admin.from('profiles').select('role, reseller_low_stock_gb').eq('id', user.id).maybeSingle(),
  ])
  const total = Number((clients as any[])?.[0]?.total_count ?? 0)

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="font-display font-bold text-2xl text-ink">Sub-users</h1>
          <p className="text-muted text-sm mt-1">Manage clients and allocate bandwidth</p>
        </div>
        <div className="text-right">
          <div className="text-xs font-mono text-muted">Available stock</div>
          <div className="font-display font-bold text-accent">{formatGb(bw?.available_gb)} GB</div>
        </div>
      </div>
      {(me?.role === 'reseller' || me?.role === 'admin') && <ResellerStockAlert initialGb={me.reseller_low_stock_gb == null ? null : Number(me.reseller_low_stock_gb)} />}
      <ResellerUsersList
        clients={(clients as any[]) ?? []}
        availableGb={Number(bw?.available_gb ?? 0)}
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        query={q}
        filter={filter}
        sort={sort}
      />
    </div>
  )
}
