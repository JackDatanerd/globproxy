import Link from 'next/link'
import { createAdminClient, createClient } from '@/lib/supabase/server'
import AdminPager, { parsePage, cleanSearch } from '@/components/admin/AdminPager'
import AdminQueryError from '@/components/admin/AdminQueryError'
import { ticketTag } from '@/lib/inboxCore'

const PAGE_SIZE = 30
const STATUSES = ['open', 'pending', 'closed', 'all'] as const

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 86400 * 14) return `${Math.floor(s / 86400)} d ago`
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

// Everything customers send to support@globproxy.com (migration 0091). Unread first, then newest.
export default async function AdminInboxPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const page = parsePage(sp.page)
  const status = typeof sp.status === 'string' && (STATUSES as readonly string[]).includes(sp.status) ? sp.status : 'open'
  const mine = sp.mine === '1'
  const q = cleanSearch(sp.q)

  const supabase = await createAdminClient()
  const { data: { user } } = await (await createClient()).auth.getUser()
  const me = user?.id ?? null

  const from = (page - 1) * PAGE_SIZE
  let query = supabase.from('inbox_threads')
    .select('id, ticket_no, subject, customer_email, customer_user_id, status, assigned_to, unread, message_count, last_message_at, assignee:assigned_to(email)', { count: 'exact' })
  if (status !== 'all') query = query.eq('status', status)
  if (mine && me) query = query.eq('assigned_to', me)
  const ticket = /^(?:gp-?)?(\d{1,12})$/i.exec(q)
  if (q) query = ticket ? query.eq('ticket_no', Number(ticket[1])) : query.or(`subject.ilike.%${q}%,customer_email.ilike.%${q}%`)

  const count = (s: string) => supabase.from('inbox_threads').select('*', { count: 'exact', head: true }).eq('status', s)
  const [{ data: threads, count: total, error }, { count: openN }, { count: pendingN }, { count: closedN }, { count: unreadN }] = await Promise.all([
    query.order('unread', { ascending: false }).order('last_message_at', { ascending: false }).range(from, from + PAGE_SIZE - 1),
    count('open'), count('pending'), count('closed'),
    supabase.from('inbox_threads').select('*', { count: 'exact', head: true }).eq('unread', true).neq('status', 'closed'),
  ])

  const href = (over: Record<string, string>) => {
    const p = new URLSearchParams({ status, ...(mine ? { mine: '1' } : {}), ...(q ? { q } : {}), ...over })
    for (const [k, v] of [...p.entries()]) if (!v) p.delete(k)
    return `/admin/inbox?${p}`
  }
  const chip = (on: boolean) => `text-xs font-mono px-3 py-1.5 rounded-full border transition-all ${on ? 'bg-ink text-white border-ink' : 'border-border text-ink2 hover:border-ink2'}`

  return (
    <div className="max-w-5xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">Inbox</h1>
        <p className="text-muted text-sm mt-1">
          Mail sent to support@globproxy.com{unreadN ? <> — <strong className="text-ink">{unreadN} unread</strong></> : null}. Replies leave from the same address.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <Link href={href({ status: 'open', page: '' })} className={chip(status === 'open')}>{openN ?? 0} open</Link>
        <Link href={href({ status: 'pending', page: '' })} className={chip(status === 'pending')}>{pendingN ?? 0} waiting on customer</Link>
        <Link href={href({ status: 'closed', page: '' })} className={chip(status === 'closed')}>{closedN ?? 0} closed</Link>
        <Link href={href({ status: 'all', page: '' })} className={chip(status === 'all')}>All</Link>
        <Link href={href({ mine: mine ? '' : '1', page: '' })} className={chip(mine)}>Assigned to me</Link>
        <form method="get" className="ml-auto flex gap-2">
          <input type="hidden" name="status" value={status} />
          {mine && <input type="hidden" name="mine" value="1" />}
          <input name="q" defaultValue={q} placeholder="Subject, e-mail or GP-123…" aria-label="Search the inbox" className="w-60 bg-white border border-border px-3 py-1.5 rounded-lg text-xs focus:outline-none focus:border-accent" />
          <button className="text-xs font-mono px-3 py-1.5 rounded-lg border border-border text-ink2 hover:border-ink2">Search</button>
          {q && <Link href={href({ q: '', page: '' })} className="text-xs font-mono px-2 py-1.5 text-muted hover:text-ink">Clear</Link>}
        </form>
      </div>

      {error ? <AdminQueryError what="the inbox (has migration 0091 been applied?)" /> : null}
      {!error && (threads ?? []).length === 0 ? (
        <div className="bg-white border border-border rounded-xl p-12 text-center text-muted text-sm font-light">
          {q ? 'Nothing matches that search.' : status === 'open' ? 'Nothing waiting — inbox zero.' : 'No conversations here.'}
        </div>
      ) : (
        <div className="bg-white border border-border rounded-xl divide-y divide-border overflow-hidden">
          {(threads ?? []).map((t: any) => (
            <Link key={t.id} href={`/admin/inbox/${t.id}`} className="flex items-start gap-3 px-5 py-4 hover:bg-surface transition-colors">
              <span aria-label={t.unread ? 'Unread' : 'Read'} className={`mt-1.5 h-2 w-2 rounded-full flex-shrink-0 ${t.unread ? 'bg-accent' : 'bg-transparent'}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className={`text-sm truncate ${t.unread ? 'font-semibold text-ink' : 'text-ink'}`}>{t.subject}</span>
                  <span className="text-[10px] font-mono text-muted flex-shrink-0">{ticketTag(Number(t.ticket_no))}</span>
                </div>
                <div className="text-xs font-mono text-muted mt-0.5 truncate">
                  {t.customer_email}
                  {t.customer_user_id ? <span className="ml-2 text-accent2">● customer</span> : null}
                  {t.assignee?.email ? <span className="ml-2">→ {t.assignee.email}</span> : null}
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                <div className="text-[11px] font-mono text-muted">{ago(t.last_message_at)}</div>
                <div className="text-[10px] font-mono text-muted mt-0.5">
                  {t.message_count} msg{t.message_count === 1 ? '' : 's'}{t.status !== 'open' ? ` · ${t.status === 'pending' ? 'waiting' : t.status}` : ''}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
      <AdminPager basePath="/admin/inbox" page={page} pageSize={PAGE_SIZE} total={total ?? 0} params={{ status, q, ...(mine ? { mine: '1' } : {}) }} />
    </div>
  )
}
