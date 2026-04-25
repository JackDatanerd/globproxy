import { createAdminClient } from '@/lib/supabase/server'

export default async function AdminOrdersPage() {
  const supabase = await createAdminClient()
  const { data: orders } = await supabase
    .from('orders')
    .select('*, profiles(email, full_name)')
    .order('created_at', { ascending: false })
    .limit(200)

  const paid = orders?.filter(o => o.payment_status === 'paid') ?? []
  const totalRevenue = paid.reduce((s, o) => s + Number(o.amount_usd), 0)
  const totalGb = paid.reduce((s, o) => s + Number(o.gb_amount), 0)

  return (
    <div className="max-w-6xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">Orders</h1>
        <p className="text-muted text-sm mt-1">All purchase activity across the platform</p>
      </div>
      <div className="grid grid-cols-3 gap-4 mb-8">
        {[
          ['Total revenue', `$${totalRevenue.toLocaleString('en-US', { minimumFractionDigits: 2 })}`, 'text-accent2'],
          ['Total GB sold', `${totalGb.toFixed(1)} GB`, 'text-accent'],
          ['Paid orders', String(paid.length), 'text-ink'],
        ].map(([l, v, c]) => (
          <div key={l} className="bg-white border border-border rounded-xl p-5">
            <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-2">{l}</div>
            <div className={`font-display text-3xl font-bold ${c}`}>{v}</div>
          </div>
        ))}
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
            {orders?.map((o, i) => (
              <tr key={o.id} className={`${i < orders.length - 1 ? 'border-b border-border' : ''} hover:bg-surface`}>
                <td className="px-6 py-4 text-xs font-mono text-muted">
                  {new Date(o.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                </td>
                <td className="px-6 py-4">
                  <div className="text-sm text-ink">{o.profiles?.full_name || 'Deleted user'}</div>
                  <div className="text-xs font-mono text-muted">{o.profiles?.email || '—'}</div>
                </td>
                <td className="px-6 py-4 font-mono text-sm font-medium text-ink">{o.gb_amount} GB</td>
                <td className="px-6 py-4 font-mono text-sm text-ink">${o.amount_usd}</td>
                <td className="px-6 py-4">
                  <span className={`text-[10px] font-mono px-2.5 py-1 rounded-full ${o.payment_status === 'paid' ? 'bg-accent2-light text-accent2' : o.payment_status === 'pending' ? 'bg-yellow-50 text-yellow-600' : 'bg-red-50 text-red-400'}`}>
                    {o.payment_status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}