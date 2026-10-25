import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import ReportIssueButton from '@/components/dashboard/ReportIssueButton'

// The "Report an issue" dialog used to be write-only: a customer who sent a
// report had no way to see it again, whether it was still open, or what they
// had written. RLS ("User can view own reports") already scopes this query to
// the signed-in user; the explicit filter is belt and braces.
export default async function SupportPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const { data: reports, error } = await supabase
    .from('support_reports')
    .select('id, message, page_url, status, created_at, resolved_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(50)

  const fmt = (d: string) => new Date(d).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'

  return (
    <div className="max-w-3xl">
      <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
        <div>
          <h1 className="font-display font-bold text-2xl text-ink mb-1">Support</h1>
          <p className="text-sm text-muted">Tell us about a payment, a proxy or anything else. We email you back at the address on your account.</p>
        </div>
        <ReportIssueButton variant="primary" />
      </div>

      <div className="bg-white border border-border rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <div className="text-sm font-medium text-ink">Your reports</div>
        </div>
        {error ? (
          <div className="px-6 py-8 text-sm text-red-600 text-center">Couldn&apos;t load your reports. Please refresh and try again.</div>
        ) : !reports || reports.length === 0 ? (
          <div className="px-6 py-10 text-sm text-muted text-center">You haven&apos;t sent any reports yet.</div>
        ) : (
          <ul className="divide-y divide-border">
            {reports.map(r => (
              <li key={r.id} className="px-6 py-4">
                <div className="flex items-center justify-between gap-3 mb-1.5">
                  <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full ${r.status === 'resolved' ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}`}>
                    {r.status === 'resolved' ? 'Resolved' : 'Open — we\u2019re on it'}
                  </span>
                  <span className="text-[11px] text-muted font-mono">
                    {fmt(r.created_at)}{r.resolved_at ? ` · resolved ${fmt(r.resolved_at)}` : ''}
                  </span>
                </div>
                <p className="text-sm text-ink2 whitespace-pre-wrap break-words">{r.message}</p>
                {r.page_url && <p className="text-[11px] text-muted font-mono mt-1.5">From {r.page_url}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-[11px] text-muted mt-3">Replies come by email, so check your spam folder if you&apos;re expecting one.</p>
    </div>
  )
}
