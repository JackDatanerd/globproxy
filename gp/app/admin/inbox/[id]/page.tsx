import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createAdminClient, createClient } from '@/lib/supabase/server'
import { isUuid } from '@/lib/adminAuth'
import { ticketTag } from '@/lib/inboxCore'
import InboxThreadActions from '@/components/admin/InboxThreadActions'
import InboxReplyForm from '@/components/admin/InboxReplyForm'

const fmt = (d: string) => new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

// One conversation. Message text is rendered as plain text only — never as HTML — so nothing a
// stranger e-mails us can run in an administrator's browser.
export default async function AdminInboxThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) notFound()
  const supabase = await createAdminClient()
  const { data: { user } } = await (await createClient()).auth.getUser()

  const [{ data: thread }, { data: msgs }] = await Promise.all([
    supabase.from('inbox_threads')
      .select('id, ticket_no, subject, customer_email, customer_user_id, status, assigned_to, unread, created_at, assignee:assigned_to(email)').eq('id', id).maybeSingle(),
    supabase.from('inbox_messages')
      .select('id, direction, from_email, from_name, to_emails, cc_emails, text_body, had_html, attachments, is_auto, delivery_status, delivery_error, created_at, sender:sent_by(email)')
      .eq('thread_id', id).order('created_at', { ascending: true }),
  ])
  if (!thread) notFound()

  const { count: reports } = thread.customer_user_id
    ? await supabase.from('support_reports').select('*', { count: 'exact', head: true }).eq('user_id', thread.customer_user_id).eq('status', 'open')
    : { count: 0 }

  const t: any = thread
  return (
    <div className="max-w-4xl">
      <Link href="/admin/inbox" className="text-xs font-mono text-muted hover:text-ink">← Inbox</Link>
      <div className="flex items-start justify-between gap-4 flex-wrap mt-3 mb-6">
        <div className="min-w-0">
          <h1 className="font-display font-bold text-xl text-ink break-words">{t.subject} <span className="text-xs font-mono text-muted font-normal">{ticketTag(Number(t.ticket_no))}</span></h1>
          <div className="text-xs font-mono text-muted mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
            <span>{t.customer_email}</span>
            {t.customer_user_id
              ? <Link href={`/admin/users/${t.customer_user_id}`} className="text-accent hover:underline">Open the customer&apos;s account →</Link>
              : <span>no account with this address</span>}
            {t.customer_user_id && (reports ?? 0) > 0 && <Link href={`/admin/support?user=${t.customer_user_id}`} className="text-accent hover:underline">{reports} open support report{reports === 1 ? '' : 's'} →</Link>}
            <span>status: {t.status === 'pending' ? 'waiting on customer' : t.status}</span>
            <span>{t.assignee?.email ? `assigned to ${t.assignee.email}` : 'unassigned'}</span>
          </div>
        </div>
        <InboxThreadActions threadId={t.id} status={t.status} assignedTo={t.assigned_to} adminId={user?.id ?? ''} unread={!!t.unread} />
      </div>

      {t.customer_user_id && (
        <div className="mb-4 text-[11px] text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
          The &ldquo;From&rdquo; address of an e-mail can be faked. Don&apos;t reset 2FA, change an e-mail address, refund or release anything based on a message here alone — confirm through the customer&apos;s own dashboard session or a support report first.
        </div>
      )}

      <div className="flex flex-col gap-3 mb-6">
        {(msgs ?? []).map((m: any) => {
          const out = m.direction === 'out'
          return (
            <div key={m.id} className={`border rounded-xl p-5 ${out ? 'bg-surface border-border ml-8' : 'bg-white border-border mr-8'}`}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="text-xs font-mono text-muted min-w-0">
                  <span className="text-ink">{out ? `GlobProxy Support${m.sender?.email ? ` (${m.sender.email})` : ''}` : (m.from_name ? `${m.from_name} <${m.from_email}>` : m.from_email)}</span>
                  <span> → {(m.to_emails ?? []).join(', ') || 'support@globproxy.com'}</span>
                  {(m.cc_emails ?? []).length > 0 && <span> · cc {(m.cc_emails as string[]).join(', ')}</span>}
                </div>
                <div className="text-[11px] font-mono text-muted flex-shrink-0">{fmt(m.created_at)}</div>
              </div>
              {m.is_auto && <div className="mt-2 inline-block text-[10px] font-mono text-amber-700 bg-amber-50 border border-amber-100 rounded-full px-2 py-0.5">automatic message (auto-reply / bounce / bulk)</div>}
              {out && m.delivery_status === 'failed' && <div role="alert" className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">Not delivered: {m.delivery_error ?? 'the mail provider refused it'}.</div>}
              {out && m.delivery_status === 'unknown' && <div role="alert" className="mt-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">Delivery unknown — the mail provider did not confirm it. Check with the customer before sending it again.</div>}
              <pre className="mt-3 text-sm text-ink whitespace-pre-wrap break-words font-sans">{m.text_body || '(empty message)'}</pre>
              {m.had_html && !out && <div className="mt-2 text-[10px] font-mono text-muted">This message also had a formatted (HTML) version; only the text is shown.</div>}
              {Array.isArray(m.attachments) && m.attachments.length > 0 && (
                <div className="mt-3 text-[11px] font-mono text-muted">
                  Attachments (not stored — ask the sender to resend if you need them): {m.attachments.map((a: any) => `${a.filename ?? 'unnamed'} (${kb(Number(a.size) || 0)})`).join(', ')}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <InboxReplyForm threadId={t.id} to={t.customer_email} />
    </div>
  )
}
