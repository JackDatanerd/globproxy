import { createAdminClient } from '@/lib/supabase/server'
import Link from 'next/link'
import AdminStockPanel from '@/components/admin/AdminStockPanel'
import { formatGb } from '@/lib/format'

export default async function AdminPage() {
  const supabase = await createAdminClient()
  const [
    { count: totalUsers },
    { count: totalResellers },
    { data: orders },
    { data: recentUsers },
  ] = await Promise.all([
    supabase.from('profiles').select('*',{count:'exact',head:true}).eq('role','user'),
    supabase.from('profiles').select('*',{count:'exact',head:true}).eq('role','reseller'),
    supabase.from('orders').select('amount_usd,payment_status,gb_amount,created_at').eq('payment_status','paid'),
    supabase.from('profiles').select('email,full_name,role,created_at').order('created_at',{ascending:false}).limit(5),
  ])

  const totalRevenue = orders?.reduce((s,o)=>s+o.amount_usd,0)??0
  const totalGbSold = orders?.reduce((s,o)=>s+o.gb_amount,0)??0
  const now = new Date()
  const thisMonth = orders?.filter(o=>{const d=new Date(o.created_at);return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear()}).reduce((s,o)=>s+o.amount_usd,0)??0

  return (
    <div className="max-w-6xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">Admin Overview</h1>
        <p className="text-muted text-sm mt-1">Platform health, finances, and controls</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[
          {label:'Total revenue',value:`$${totalRevenue.toLocaleString('en-US',{minimumFractionDigits:2})}`,color:'text-accent2',sub:'All time'},
          {label:'This month',value:`$${thisMonth.toLocaleString('en-US',{minimumFractionDigits:2})}`,color:'text-accent',sub:now.toLocaleString('default',{month:'long'})},
          {label:'Total GB sold',value:`${formatGb(totalGbSold)} GB`,color:'text-ink',sub:'All time'},
          {label:'Total orders',value:String(orders?.length??0),color:'text-ink',sub:'Paid only'},
        ].map(m=>(
          <div key={m.label} className="bg-white border border-border rounded-xl p-5">
            <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-2">{m.label}</div>
            <div className={`font-display text-3xl font-bold ${m.color}`}>{m.value}</div>
            <div className="text-xs text-muted mt-1">{m.sub}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[
          {label:'Regular users',value:String(totalUsers??0),color:'text-ink'},
          {label:'Resellers',value:String(totalResellers??0),color:'text-accent2'},
          {label:'Total accounts',value:String((totalUsers??0)+(totalResellers??0)),color:'text-ink'},
          {label:'Cost per GB',value:'$0.49',color:'text-muted',sub:'Geonode wholesale'},
        ].map(m=>(
          <div key={m.label} className="bg-white border border-border rounded-xl p-5">
            <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-2">{m.label}</div>
            <div className={`font-display text-3xl font-bold ${m.color}`}>{m.value}</div>
            {'sub' in m && <div className="text-xs text-muted mt-1">{m.sub}</div>}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        <div className="lg:col-span-2"><AdminStockPanel /></div>
        <div className="bg-white border border-border rounded-xl p-6">
          <h2 className="font-display font-bold text-base text-ink mb-5">Quick actions</h2>
          <div className="flex flex-col gap-2">
            {[
              {label:'Manage users',href:'/admin/users'},
              {label:'View all orders',href:'/admin/orders'},
              {label:'Reseller approvals',href:'/admin/resellers'},
              {label:'All credentials',href:'/admin/credentials'},
            ].map(a=>(
              <Link key={a.href} href={a.href} className="flex items-center justify-between px-4 py-3 border border-border rounded-xl text-sm text-ink2 hover:border-accent hover:text-accent transition-all">
                {a.label}<span>→</span>
              </Link>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-white border border-border rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-border flex justify-between items-center">
          <h2 className="font-display font-bold text-base text-ink">Recent signups</h2>
          <Link href="/admin/users" className="text-xs font-mono text-accent hover:underline">View all →</Link>
        </div>
        <table className="w-full">
          <thead><tr className="border-b border-border bg-surface">{['User','Role','Joined'].map(h=><th key={h} className="text-left px-6 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>)}</tr></thead>
          <tbody>
            {recentUsers?.map((u,i)=>(
              <tr key={i} className={`${i<(recentUsers.length-1)?'border-b border-border':''} hover:bg-surface`}>
                <td className="px-6 py-3"><div className="text-sm font-medium text-ink">{u.full_name||'—'}</div><div className="text-xs font-mono text-muted">{u.email}</div></td>
                <td className="px-6 py-3"><span className={`text-[10px] font-mono px-2.5 py-1 rounded-full ${u.role==='admin'?'bg-accent-light text-accent':u.role==='reseller'?'bg-accent2-light text-accent2':'bg-surface text-muted border border-border'}`}>{u.role}</span></td>
                <td className="px-6 py-3 text-xs font-mono text-muted">{new Date(u.created_at).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
