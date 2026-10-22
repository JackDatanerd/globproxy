import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/server'
import AdminClearFlagButton from '@/components/admin/AdminClearFlagButton'
import AdminConfirmFraudButton from '@/components/admin/AdminConfirmFraudButton'
import AdminReasonActionButton from '@/components/admin/AdminReasonActionButton'
import AdminPager, { parsePage } from '@/components/admin/AdminPager'

const PAGE_SIZE = 50

const REASONS: Record<string, string> = {
  shared_signup_ip: 'Another referral on this code signed up from the same IP address',
}

// Referrals the system flagged for review. A flagged referral earns nothing
// (no GB bonus, no commission) until cleared here — see migrations 0044 / 0051.
// "Confirm fraud" keeps one blocked for good and takes it out of the queue
// (migration 0052).
export default async function AdminReferralsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const page = parsePage(sp.page)
  const view = sp.view === 'confirmed' ? 'confirmed' : 'review'

  const supabase = await createAdminClient()
  const from = (page - 1) * PAGE_SIZE

  let query = supabase
    .from('referrals')
    .select('id, referrer_id, created_at, flag_reason, flag_confirmed_at, signup_ip_hash, sub_id, referrer:referrer_id(email, full_name, affiliate_status, is_deleted), referred:referred_user_id(email, is_deleted)', { count: 'exact' })
    .eq('flagged', true)
  query = view === 'confirmed' ? query.not('flag_confirmed_at', 'is', null) : query.is('flag_confirmed_at', null)
  const { data: flagged, count, error } = await query.order('created_at', { ascending: false }).range(from, from + PAGE_SIZE - 1)

  const [{ count: reviewCount }, { count: confirmedCount }] = await Promise.all([
    supabase.from('referrals').select('*', { count: 'exact', head: true }).eq('flagged', true).is('flag_confirmed_at', null),
    supabase.from('referrals').select('*', { count: 'exact', head: true }).eq('flagged', true).not('flag_confirmed_at', 'is', null),
  ])

  // How many referrals share each row's signup IP (hash), and how many of
  // those are on the same code — the evidence for "same person, many signups".
  const hashes = Array.from(new Set((flagged ?? []).map((r: any) => r.signup_ip_hash).filter(Boolean)))
  const sameIp: Record<string, { total: number; sameReferrer: Record<string, number> }> = {}
  if (hashes.length) {
    const { data: cluster } = await supabase
      .from('referrals').select('signup_ip_hash, referrer_id').in('signup_ip_hash', hashes).limit(5000)
    for (const c of cluster ?? []) {
      const e = (sameIp[c.signup_ip_hash] ??= { total: 0, sameReferrer: {} })
      e.total++
      e.sameReferrer[c.referrer_id] = (e.sameReferrer[c.referrer_id] ?? 0) + 1
    }
  }

  const chip = (on: boolean) => `text-xs font-mono px-3 py-1.5 rounded-full border transition-all ${on ? 'bg-ink text-white border-ink' : 'border-border text-ink2 hover:border-ink2'}`

  return (
    <div className="max-w-5xl">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display font-bold text-2xl text-ink">Flagged referrals</h1>
          <p className="text-muted text-sm mt-1">
            Held back automatically — they earn nothing until you decide. <strong>Clear</strong> back-fills what the referred user&apos;s orders would have earned;
            <strong> Confirm fraud</strong> keeps it blocked for good. Look for the same person signing up repeatedly through one affiliate&apos;s code to collect commission on their own purchases.
          </p>
        </div>
        <Link href="/admin/affiliates" className="text-xs font-mono text-accent hover:underline whitespace-nowrap mt-1">← Affiliates</Link>
      </div>

      <div className="flex gap-2 mb-4">
        <Link href="/admin/referrals" className={chip(view === 'review')}>{reviewCount ?? 0} to review</Link>
        <Link href="/admin/referrals?view=confirmed" className={chip(view === 'confirmed')}>{confirmedCount ?? 0} confirmed fraud</Link>
      </div>

      {error ? (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl p-5">
          Couldn&apos;t load flagged referrals — have migrations 0044 and 0052 been run?
        </div>
      ) : (flagged ?? []).length === 0 ? (
        <div className="bg-white border border-border rounded-xl p-12 text-center text-muted text-sm font-light">
          {view === 'review' ? 'Nothing waiting for review.' : 'No confirmed fraud.'}
        </div>
      ) : (
        <div className="bg-white border border-border rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-surface">
                {['Referrer', 'Referred user', 'Why', 'Signed up', ''].map(h => (
                  <th key={h} className="text-left px-6 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(flagged as any[]).map((r, i) => {
                const c = r.signup_ip_hash ? sameIp[r.signup_ip_hash] : null
                return (
                  <tr key={r.id} className={i < flagged!.length - 1 ? 'border-b border-border' : ''}>
                    <td className="px-6 py-4">
                      <Link href={`/admin/affiliates/${r.referrer_id}`} className="text-sm font-medium text-ink hover:text-accent hover:underline">{r.referrer?.full_name || '—'}</Link>
                      <div className="text-xs font-mono text-muted">{r.referrer?.email}</div>
                    </td>
                    <td className="px-6 py-4 text-xs font-mono text-ink">{r.referred?.is_deleted ? 'deleted account' : r.referred?.email}</td>
                    <td className="px-6 py-4 text-xs text-muted max-w-[260px]">
                      {REASONS[r.flag_reason] ?? r.flag_reason ?? '—'}
                      {c && c.total > 1 && (
                        <div className="text-[11px] font-mono mt-1 text-amber-700">
                          {c.total} referrals from this IP · {c.sameReferrer[r.referrer_id] ?? 0} on this affiliate&apos;s code
                        </div>
                      )}
                      {r.flag_confirmed_at && <div className="text-[11px] font-mono mt-1 text-red-600">confirmed {new Date(r.flag_confirmed_at).toLocaleDateString('en-GB')}</div>}
                    </td>
                    <td className="px-6 py-4 text-xs font-mono text-muted whitespace-nowrap">
                      {new Date(r.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex gap-2 justify-end">
                        {!r.flag_confirmed_at && <AdminConfirmFraudButton referralId={r.id} />}
                        <AdminReasonActionButton label="Void earnings" endpoint="/api/admin/void-referral-earnings" payload={{ referralId: r.id }}
                          confirmText="Void everything this referral earned? Unpaid commissions are removed; commissions already paid out become deductions against the affiliate's future payouts." successText="Earnings voided" />
                        <AdminClearFlagButton referralId={r.id} />
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <AdminPager basePath="/admin/referrals" page={page} pageSize={PAGE_SIZE} total={count ?? 0} params={{ view: view === 'confirmed' ? 'confirmed' : '' }} />
    </div>
  )
}
