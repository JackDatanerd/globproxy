import { createAdminClient } from '@/lib/supabase/server'
import Link from 'next/link'
import AdminStockPanel from '@/components/admin/AdminStockPanel'
import { formatGb } from '@/lib/format'
import { upstreamCostPerGbUsd } from '@/lib/constants'
import { CRON_MAX_AGE_SECONDS } from '@/lib/cronHealth'

const money = (n: number) => `$${n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`

export default async function AdminPage() {
  const supabase = await createAdminClient()
  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()

  // Revenue / GB / order counts come from admin_order_stats() (migration
  // 0043): a server-side aggregate, net of refunds, canary orders excluded.
  // This page used to download every paid order and sum it in JS, which
  // silently truncated at PostgREST's 1000-row cap once the store grew —
  // and Orders / Sales Cycles used different (gross) maths for the same
  // "revenue" number.
  // Soft-deleted accounts keep their role on a '[deleted]' tombstone row, so
  // every account count / signup list excludes is_deleted.
  const [
    { count: totalUsers },
    { count: totalResellers },
    allTime,
    month,
    { data: recentUsers },
    { count: pendingResellers },
    { count: pendingAffiliates },
    { count: pendingApi },
    { count: unpaidPayouts },
    { count: flaggedReferrals },
    { count: openReports },
    { count: openDisputes },
    { count: openRefundRequests },
    { count: unfulfilledOrders },
    { count: unconfirmedRefunds },
    { data: cronRuns },
  ] = await Promise.all([
    supabase.from('profiles').select('*',{count:'exact',head:true}).eq('role','user').eq('is_deleted',false),
    supabase.from('profiles').select('*',{count:'exact',head:true}).eq('role','reseller').eq('is_deleted',false),
    supabase.rpc('admin_order_stats'),
    supabase.rpc('admin_order_stats', { p_start: monthStart }),
    supabase.from('profiles').select('email,full_name,role,created_at').eq('is_deleted',false).order('created_at',{ascending:false}).limit(5),
    supabase.from('profiles').select('*',{count:'exact',head:true}).eq('reseller_status','pending').eq('is_deleted',false),
    supabase.from('profiles').select('*',{count:'exact',head:true}).eq('affiliate_status','pending').eq('is_deleted',false),
    supabase.from('profiles').select('*',{count:'exact',head:true}).eq('api_access_status','pending').eq('is_deleted',false),
    supabase.from('affiliate_payouts').select('*',{count:'exact',head:true}).eq('status','pending'),
    // Confirmed-fraud referrals are decided; only unreviewed ones need a look.
    supabase.from('referrals').select('*',{count:'exact',head:true}).eq('flagged',true).is('flag_confirmed_at',null),
    supabase.from('support_reports').select('*',{count:'exact',head:true}).eq('status','open'),
    supabase.from('orders').select('*',{count:'exact',head:true}).eq('dispute_status','open'),
    supabase.from('refund_requests').select('*',{count:'exact',head:true}).eq('status','open'),
    // Paid but never credited, and old enough that the webhook/reconcile should have finished.
    supabase.from('orders').select('*',{count:'exact',head:true}).eq('payment_status','paid').eq('bandwidth_credited',false).eq('is_canary',false)
      .lt('created_at', new Date(now.getTime() - 15 * 60_000).toISOString()),
    // Refunds Paystack accepted but did not confirm (written to the audit log by refund-order).
    supabase.from('admin_audit_log').select('*',{count:'exact',head:true}).eq('action','order.refund_unconfirmed')
      .gte('created_at', new Date(now.getTime() - 14 * 86_400_000).toISOString()),
    supabase.from('cron_task_runs').select('task, last_run_at, consecutive_failures'),
  ])
  // Scheduled tasks failing now, or silent for ~3 missed ticks (same rule as the Settings panel).
  const failingTasks = (cronRuns ?? []).filter((r: any) => {
    const maxAge = CRON_MAX_AGE_SECONDS[r.task]
    return r.consecutive_failures > 0 || (!!maxAge && now.getTime() - new Date(r.last_run_at).getTime() > maxAge * 1000)
  }).length

  const statsOk = !allTime.error && !month.error
  const all = (allTime.data?.[0] ?? null) as { revenue_usd: number; gb_sold: number; order_count: number } | null
  const mo = (month.data?.[0] ?? null) as { revenue_usd: number } | null

  const attention = [
    { label: 'Reseller applications', n: pendingResellers ?? 0, href: '/admin/resellers' },
    { label: 'API access requests', n: pendingApi ?? 0, href: '/admin/resellers' },
    { label: 'Affiliate applications', n: pendingAffiliates ?? 0, href: '/admin/affiliates' },
    { label: 'Payouts to send', n: unpaidPayouts ?? 0, href: '/admin/affiliates' },
    { label: 'Flagged referrals', n: flaggedReferrals ?? 0, href: '/admin/referrals' },
    { label: 'Open support reports', n: openReports ?? 0, href: '/admin/support' },
    { label: 'Open payment disputes', n: openDisputes ?? 0, href: '/admin/orders?status=disputed' },
    { label: 'Refund requests', n: openRefundRequests ?? 0, href: '/admin/orders?status=refund_requested' },
    { label: 'Paid, bandwidth not credited', n: unfulfilledOrders ?? 0, href: '/admin/orders?status=unfulfilled' },
    { label: 'Refunds to confirm (14 d)', n: unconfirmedRefunds ?? 0, href: '/admin/audit?q=order.refund_unconfirmed' },
    { label: 'Scheduled tasks failing', n: failingTasks, href: '/admin/settings' },
  ]

  return (
    <div className="max-w-6xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">Admin Overview</h1>
        <p className="text-muted text-sm mt-1">Platform health, finances, and controls</p>
      </div>

      {!statsOk && (
        <div className="bg-red-50 border border-red-200 text-red-600 text-xs font-mono rounded-xl px-4 py-3 mb-6">
          Revenue stats unavailable — have migrations 0043 and 0052 been run?
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[
          {label:'Total revenue',value: all ? money(Number(all.revenue_usd)) : '—',color:'text-accent2',sub:'All time, net of refunds'},
          {label:'This month',value: mo ? money(Number(mo.revenue_usd)) : '—',color:'text-accent',sub:now.toLocaleString('default',{month:'long',timeZone:'UTC'})},
          {label:'Total GB sold',value: all ? `${formatGb(Number(all.gb_sold))} GB` : '—',color:'text-ink',sub:'All time, net of refunds'},
          {label:'Total orders',value: all ? String(all.order_count) : '—',color:'text-ink',sub:'Paid only'},
        ].map(m=>(
          <div key={m.label} className="bg-white border border-border rounded-xl p-5">
            <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-2">{m.label}</div>
            <div className={`font-display text-3xl font-bold ${m.color}`}>{m.value}</div>
            <div className="text-xs text-muted mt-1">{m.sub}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {attention.map(a=>(
          <Link key={a.label} href={a.href} className={`rounded-xl p-5 border transition-all hover:border-accent ${a.n>0?'bg-amber-50 border-amber-200':'bg-white border-border'}`}>
            <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-2">Needs attention</div>
            <div className={`font-display text-3xl font-bold ${a.n>0?'text-amber-700':'text-ink'}`}>{a.n}</div>
            <div className="text-xs text-muted mt-1">{a.label}</div>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[
          {label:'Regular users',value:String(totalUsers??0),color:'text-ink'},
          {label:'Resellers',value:String(totalResellers??0),color:'text-accent2'},
          {label:'Total accounts',value:String((totalUsers??0)+(totalResellers??0)),color:'text-ink'},
          {label:'Cost per GB',value:upstreamCostPerGbUsd()==null?'not set':`$${upstreamCostPerGbUsd()}`,color:'text-muted',sub:'Upstream wholesale'},
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
              {label:'Support reports',href:'/admin/support'},
              {label:'Banned emails',href:'/admin/bans'},
              {label:'Admin audit log',href:'/admin/audit'},
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
