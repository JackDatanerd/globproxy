import { createClient, createAdminClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import TransfersTable from '@/components/reseller/TransfersTable'
import PendingInvitations from '@/components/reseller/PendingInvitations'
import ExportButton from '@/components/dashboard/ExportButton'
import { isUuid } from '@/lib/adminAuth'

const PAGE_SIZE = 25

export default async function TransfersPage({ searchParams }: { searchParams: Promise<{ page?: string; client?: string }> }) {
  const sp = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  // ?client=<id> narrows the history to one client (linked from the roster).
  const clientId = isUuid(sp.client) ? sp.client! : null
  const page = Math.max(1, Math.min(100_000, parseInt(sp.page ?? '1', 10) || 1))
  const from = (page - 1) * PAGE_SIZE

  // Read through the service role, scoped to THIS reseller. (Resellers no
  // longer have RLS read access to client profile rows — migration 0039 — so
  // the old embedded profile join through the session client would return null.)
  const admin = await createAdminClient()
  let tq = admin
    .from('reseller_transfers')
    .select('id, created_at, gb_amount, reclaimed_gb, status, note, recipient:recipient_id(email, is_deleted)', { count: 'exact' })
    .eq('reseller_id', user.id)
  if (clientId) tq = tq.eq('recipient_id', clientId)
  // `id` breaks ties between transfers created in the same instant, so a row
  // can neither repeat nor vanish across pages.
  const { data: transfers, count, error: transfersErr } = await tq
    .order('created_at', { ascending: false }).order('id', { ascending: false })
    .range(from, from + PAGE_SIZE - 1)

  // A page past the end (a stale bookmark, a shrunk list) makes PostgREST answer with a
  // range error rather than an empty list; send the reseller back to the first page
  // instead of telling them they have no transfers. Any other failure is said out loud.
  if (transfersErr && page > 1) redirect(clientId ? `/reseller/transfers?client=${clientId}` : '/reseller/transfers')

  const { data: invites } = clientId ? { data: [] as any[] } : await admin
    .from('reseller_pending_transfers')
    .select('id, recipient_email, gb_amount, note, created_at, expires_at, reminder_count')
    .eq('reseller_id', user.id).eq('status', 'pending')
    .order('created_at', { ascending: false }).limit(100)
  const pending = (invites ?? []).map((i: any) => ({
    id: i.id, email: i.recipient_email, gb: Number(i.gb_amount), note: i.note, created_at: i.created_at, expires_at: i.expires_at, reminder_count: Number(i.reminder_count ?? 0),
  }))

  const rows = (transfers ?? []).map((t: any) => ({
    id: t.id,
    created_at: t.created_at,
    gb_amount: Number(t.gb_amount),
    reclaimed_gb: Number(t.reclaimed_gb ?? 0),
    status: t.status,
    note: t.note,
    email: t.recipient?.email ?? null,
    deleted: !!t.recipient?.is_deleted,
  }))
  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE))
  const pageQs = (p: number) => new URLSearchParams({ ...(clientId ? { client: clientId } : {}), page: String(p) }).toString()

  return (
    <div className="max-w-4xl">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display font-bold text-2xl text-ink">Transfers</h1>
          <p className="text-muted text-sm mt-1">
            {clientId
              ? <>Transfers with <strong className="text-ink">{rows[0]?.deleted ? 'a deleted account' : (rows[0]?.email ?? 'this client')}</strong> · <Link href="/reseller/transfers" className="text-accent hover:underline">Show all</Link></>
              : 'All bandwidth allocations to your clients'}
          </p>
        </div>
        <ExportButton url="/api/reseller/transfers-csv" filename="globproxy-transfers.csv"
          className="text-xs font-mono px-3 py-2 rounded-lg border border-border text-muted hover:bg-surface whitespace-nowrap">
          Export CSV ↓
        </ExportButton>
      </div>
      {pending.length > 0 && <PendingInvitations invites={pending} />}
      <div className="bg-white border border-border rounded-xl overflow-x-auto">
        {rows.length > 0 ? (
          <TransfersTable transfers={rows} />
        ) : (
          <div className="text-center py-16"><p className="text-muted text-sm font-light">{transfersErr ? 'Your transfers could not be loaded just now — reload to try again.' : 'No transfers yet.'}</p></div>
        )}
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-5 text-xs font-mono text-muted">
          {page > 1 ? <Link href={`/reseller/transfers?${pageQs(page - 1)}`} className="text-accent hover:underline">← Newer</Link> : <span />}
          <span>Page {page} of {totalPages}</span>
          {page < totalPages ? <Link href={`/reseller/transfers?${pageQs(page + 1)}`} className="text-accent hover:underline">Older →</Link> : <span />}
        </div>
      )}
    </div>
  )
}
