import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'

export default async function TransfersPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  // No proxy_credentials join: allocate/route.ts never sets credential_id
  // on a transfer (a reseller allocation is a direct allocated_gb ledger
  // move via allocate_reseller_bandwidth, not tied to any specific
  // credential), so joining it always came back null and rendered as
  // permanently-empty Label/Country columns below.
  const { data: transfers } = await supabase
    .from('reseller_transfers')
    .select('*, profiles!reseller_transfers_recipient_id_fkey(email)')
    .eq('reseller_id', user.id)
    .order('created_at', { ascending: false })

  return (
    <div className="max-w-4xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">Transfers</h1>
        <p className="text-muted text-sm mt-1">All bandwidth allocations to your clients</p>
      </div>
      <div className="bg-white border border-border rounded-xl overflow-hidden">
        {transfers && transfers.length > 0 ? (
          <table className="w-full">
            <thead><tr className="border-b border-border bg-surface">{['Date','Client','GB','Status'].map(h=><th key={h} className="text-left px-5 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>)}</tr></thead>
            <tbody>
              {transfers.map((t,i)=>{
                return (
                  <tr key={t.id} className={`${i<transfers.length-1?'border-b border-border':''} hover:bg-surface`}>
                    <td className="px-5 py-3.5 text-xs font-mono text-muted">{new Date(t.created_at).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}</td>
                    <td className="px-5 py-3.5 text-sm text-ink">{t.profiles?.email??'—'}</td>
                    <td className="px-5 py-3.5 font-mono text-sm font-medium text-ink">{t.gb_amount} GB</td>
                    <td className="px-5 py-3.5"><span className={`text-[10px] font-mono px-2.5 py-1 rounded-full ${t.status==='active'?'bg-accent2-light text-accent2':'bg-yellow-50 text-yellow-600'}`}>{t.status}</span></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <div className="text-center py-16"><p className="text-muted text-sm font-light">No transfers yet.</p></div>
        )}
      </div>
    </div>
  )
}
