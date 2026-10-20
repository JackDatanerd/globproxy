import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/server'
import AdminClearFlagButton from '@/components/admin/AdminClearFlagButton'

const REASONS: Record<string, string> = {
  shared_signup_ip: 'Another referral on this code signed up from the same IP address',
}

// Referrals the system flagged for review. A flagged referral earns nothing
// (no GB bonus, no commission) until cleared here — see migration 0044.
export default async function AdminReferralsPage() {
  const supabase = await createAdminClient()
  const { data: flagged, error } = await supabase
    .from('referrals')
    .select('id, referrer_id, created_at, flag_reason, sub_id, referrer:referrer_id(email, full_name, affiliate_status, is_deleted), referred:referred_user_id(email, is_deleted)')
    .eq('flagged', true)
    .order('created_at', { ascending: false })
    .limit(200)

  return (
    <div className="max-w-5xl">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display font-bold text-2xl text-ink">Flagged referrals</h1>
          <p className="text-muted text-sm mt-1">
            Held back automatically — they earn nothing until you clear them. Clearing back-fills what the referred user's orders would have earned. Look for the same person signing up
            repeatedly through one affiliate&apos;s code to collect commission on their own purchases.
          </p>
        </div>
        <Link href="/admin/affiliates" className="text-xs font-mono text-accent hover:underline whitespace-nowrap mt-1">← Affiliates</Link>
      </div>

      {error ? (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl p-5">
          Couldn&apos;t load flagged referrals — has migration 0044 been run?
        </div>
      ) : (flagged ?? []).length === 0 ? (
        <div className="bg-white border border-border rounded-xl p-12 text-center text-muted text-sm font-light">Nothing flagged.</div>
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
              {(flagged as any[]).map((r, i) => (
                <tr key={r.id} className={i < flagged!.length - 1 ? 'border-b border-border' : ''}>
                  <td className="px-6 py-4">
                    <Link href={`/admin/affiliates/${r.referrer_id}`} className="text-sm font-medium text-ink hover:text-accent hover:underline">{r.referrer?.full_name || '—'}</Link>
                    <div className="text-xs font-mono text-muted">{r.referrer?.email}</div>
                  </td>
                  <td className="px-6 py-4 text-xs font-mono text-ink">{r.referred?.is_deleted ? 'deleted account' : r.referred?.email}</td>
                  <td className="px-6 py-4 text-xs text-muted max-w-[240px]">{REASONS[r.flag_reason] ?? r.flag_reason ?? '—'}</td>
                  <td className="px-6 py-4 text-xs font-mono text-muted whitespace-nowrap">
                    {new Date(r.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </td>
                  <td className="px-6 py-4 text-right"><AdminClearFlagButton referralId={r.id} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
