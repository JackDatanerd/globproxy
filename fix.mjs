import { writeFileSync } from 'fs'

writeFileSync('gp/app/admin/orders/page.tsx', `import { createAdminClient } from '@/lib/supabase/server'

export default async function AdminOrdersPage() {
  const supabase = await createAdminClient()
  const { data: orders, error } = await supabase
    .from('orders')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200)

  console.log('orders', orders?.length, error)

  const paid = orders?.filter(o => o.payment_status === 'paid') ?? []
  const totalRevenue = paid.reduce((s, o) => s + Number(o.amount_usd), 0)
  const totalGb = paid.reduce((s, o) => s + Number(o.gb_amount), 0)

  return (
    <div className="max-w-6xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">Orders</h1>
        <p className="text-muted text-sm mt-1">{orders?.length ?? 0} orders found</p>
      </div>
      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="bg-white border border-border rounded-xl p-5">
          <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-2">Total revenue</div>
          <div className="font-display text-3xl font-bold text-accent2">\${totalRevenue.toFixed(2)}</div>
        </div>
        <div className="bg-white border border-border rounded-xl p-5">
          <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-2">Total GB sold</div>
          <div className="font-display text-3xl font-bold text-accent">{totalGb.toFixed(1)} GB</div>
        </div>
        <div className="bg-white border border-border rounded-xl p-5">
          <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-2">Paid orders</div>
          <div className="font-display text-3xl font-bold text-ink">{paid.length}</div>
        </div>
      </div>
      <div className="bg-white border border-border rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-surface">
              {['Date', 'GB', 'Amount', 'Status'].map(h => (
                <th key={h} className="text-left px-6 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {orders?.map((o, i) => (
              <tr key={o.id} className="border-b border-border hover:bg-surface">
                <td className="px-6 py-4 text-xs font-mono text-muted">{new Date(o.created_at).toLocaleDateString()}</td>
                <td className="px-6 py-4 font-mono text-sm">{o.gb_amount} GB</td>
                <td className="px-6 py-4 font-mono text-sm">\${o.amount_usd}</td>
                <td className="px-6 py-4 text-xs font-mono">{o.payment_status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}`, 'utf8')

console.log('Done')