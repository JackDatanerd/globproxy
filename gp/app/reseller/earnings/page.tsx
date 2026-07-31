import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'

export default async function EarningsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const [{ data: transfers }, { data: bw }] = await Promise.all([
    supabase.from('reseller_transfers').select('*, profiles!reseller_transfers_recipient_id_fkey(email)').eq('reseller_id',user.id).order('created_at',{ascending:false}),
    supabase.from('bandwidth_accounts').select('*').eq('user_id',user.id).single(),
  ])
  const totalAllocated = transfers?.reduce((s,t)=>s+t.gb_amount,0)??0
  const active = transfers?.filter(t=>t.status==='active')??[]
  const pending = transfers?.filter(t=>t.status==='pending')??[]

  return (
    <div className="max-w-4xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">Earnings & Stock</h1>
        <p className="text-muted text-sm mt-1">Track your bandwidth allocation and activity</p>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {[['Stock available',`${(bw?.available_gb??0).toFixed(1)} GB`,'text-accent'],['Total allocated',`${totalAllocated.toFixed(1)} GB`,'text-ink'],['Active clients',String(active.length),'text-accent2'],['Pending payment',String(pending.length),'text-yellow-500']].map(([l,v,c])=>(
          <div key={l} className="bg-white border border-border rounded-xl p-5">
            <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-2">{l}</div>
            <div className={`font-display text-3xl font-bold ${c}`}>{v}</div>
          </div>
        ))}
      </div>
      <div className="bg-white border border-border rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="font-display font-bold text-base text-ink">Transfer history</h2>
          <div className="flex gap-2">
            <span className="text-[10px] font-mono bg-accent2-light text-accent2 px-2.5 py-1 rounded-full">{active.length} active</span>
            <span className="text-[10px] font-mono bg-yellow-50 text-yellow-600 px-2.5 py-1 rounded-full">{pending.length} pending</span>
          </div>
        </div>
        {transfers && transfers.length > 0 ? (
          <table className="w-full">
            <thead><tr className="border-b border-border bg-surface">{['Date','Client','GB','Status','Activated'].map(h=><th key={h} className="text-left px-6 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>)}</tr></thead>
            <tbody>
              {transfers.map((t,i)=>(
                <tr key={t.id} className={`${i<transfers.length-1?'border-b border-border':''} hover:bg-surface`}>
                  <td className="px-6 py-4 text-xs font-mono text-muted">{new Date(t.created_at).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}</td>
                  <td className="px-6 py-4 text-sm text-ink">{t.profiles?.email??'—'}</td>
                  <td className="px-6 py-4 font-mono text-sm font-medium text-ink">{t.gb_amount} GB</td>
                  <td className="px-6 py-4"><span className={`text-[10px] font-mono px-2.5 py-1 rounded-full ${t.status==='active'?'bg-accent2-light text-accent2':'bg-yellow-50 text-yellow-600'}`}>{t.status}</span></td>
                  <td className="px-6 py-4 text-xs font-mono text-muted">{t.activated_at?new Date(t.activated_at).toLocaleDateString('en-GB',{day:'2-digit',month:'short'}):'—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-center py-14"><p className="text-muted text-sm font-light">No transfers yet.</p></div>
        )}
      </div>
    </div>
  )
}
