import { createAdminClient } from '@/lib/supabase/server'
import { formatGb } from '@/lib/format'

export default async function AdminOrdersPage() {
  const supabase = await createAdminClient()
  const { data: orders } = await supabase
    .from('orders')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200)

  // Stats were previously computed from the same 200-row limited list used
  // for the table below — past 200 total orders, "Total revenue"/"Total GB
  // sold"/"Paid orders" would silently undercount with no indication
  // anything was truncated. Pulling just the two numeric columns, unlimited,
  // keeps this cheap while making the headline stats always correct.
  const { data: allPaid } = await supabase
    .from('orders')
    .select('amount_usd, gb_amount')
    .eq('payment_status', 'paid')
    .eq('is_canary', false) // canary's daily $0.50 test charge isn't real revenue

  const totalRevenue = allPaid?.reduce((s, o) => s + Number(o.amount_usd), 0) ?? 0
  const totalGb = allPaid?.reduce((s, o) => s + Number(o.gb_amount), 0) ?? 0
  const paidCount = allPaid?.length ?? 0

  const userIds = [...new Set(orders?.map(o => o.user_id).filter(Boolean) ?? [])]
  const { data: profiles } = userIds.length > 0
    ? await supabase.from('profiles').select('id, email, full_name').in('id', userIds)
    : { data: [] }
  const profileMap = Object.fromEntries((profiles ?? []).map(p => [p.id, p]))

  return (
    <div className="max-w-6xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">Orders</h1>
        <p className="text-muted text-sm mt-1">All purchase activity across the platform</p>
      </div>
      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="bg-white border border-border rounded-xl p-5">
          <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-2">Total revenue</div>
          <div className="font-display text-3xl font-bold text-accent2">${totalRevenue.toFixed(2)}</div>
        </div>
        <div className="bg-white border border-border rounded-xl p-5">
          <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-2">Total GB sold</div>
          <div className="font-display text-3xl font-bold text-accent">{formatGb(totalGb)} GB</div>
        </div>
        <div className="bg-white border border-border rounded-xl p-5">
          <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-2">Paid orders</div>
          <div className="font-display text-3xl font-bold text-ink">{paidCount}</div>
        </div>
      </div>
      <div className="bg-white border border-border rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-surface">
              {['Date', 'User', 'GB', 'Amount', 'Status'].map(h => (
                <th key={h} className="text-left px-6 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {orders?.map((o, i) => {
              const profile = o.user_id ? profileMap[o.user_id] : null
              return (
                <tr key={o.id} className="border-b border-border hover:bg-surface">
                  <td className="px-6 py-4 text-xs font-mono text-muted">{new Date(o.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                  <td className="px-6 py-4">
                    <div className="text-sm text-ink">{profile?.full_name || 'Deleted user'}</div>
                    <div className="text-xs font-mono text-muted">{profile?.email || '-'}</div>
                  </td>
                  <td className="px-6 py-4 font-mono text-sm font-medium text-ink">{o.gb_amount} GB</td>
                  <td className="px-6 py-4 font-mono text-sm text-ink">${o.amount_usd}</td>
                  <td className="px-6 py-4">
                    <span className={`text-[10px] font-mono px-2.5 py-1 rounded-full ${o.payment_status === 'paid' ? 'bg-accent2-light text-accent2' : o.payment_status === 'pending' ? 'bg-yellow-50 text-yellow-600' : 'bg-red-50 text-red-400'}`}>
                      {/* failure_reason only exists on orders the webhook's new
                          charge.failed handler touched (migration 0036) — a stale
                          'pending' order the 24h cleanup cron flips to 'failed'
                          has no reason recorded, so that case still just shows
                          plain "failed" rather than a misleading "failed - " */}
                      {o.payment_status === 'failed' && o.failure_reason
                        ? `failed - ${o.failure_reason.toLowerCase()}`
                        : o.payment_status}
                    </span>
                    {o.is_canary && (
                      <div className="text-[10px] font-mono text-muted mt-1">canary test</div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}