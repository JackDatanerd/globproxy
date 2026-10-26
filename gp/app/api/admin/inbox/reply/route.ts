import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, isUuid, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { sendThreadReply, buildReplyText } from '@/lib/inboxMail'

const MAX_REPLY_CHARS = 10_000

// POST { threadId, body } — answers a customer from support@globproxy.com.
//
// The reply is written to the thread FIRST (delivery 'unknown'), then handed to the mail provider
// with the row id as its Idempotency-Key, then marked 'sent' or 'failed'. So a crash between the
// two never loses the record, a retry of the same call cannot send twice, and a provider failure
// is visible on the thread instead of looking like a delivered message.
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ threadId?: unknown; body?: unknown }>(req)
  if (!body || !isUuid(body.threadId)) return badRequest('Thread ID missing or invalid')
  if (typeof body.body !== 'string') return badRequest('Write the reply first.')
  const text = body.body.replace(/\r\n/g, '\n').trim()
  if (text.length < 2) return badRequest('Write the reply first.')
  if (text.length > MAX_REPLY_CHARS) return badRequest(`Replies are limited to ${MAX_REPLY_CHARS.toLocaleString()} characters.`)

  const { data: thread, error: tErr } = await supabase.from('inbox_threads')
    .select('id, ticket_no, subject, customer_email, customer_user_id, assigned_to').eq('id', body.threadId).maybeSingle()
  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 })
  if (!thread) return NextResponse.json({ error: 'This conversation no longer exists.' }, { status: 404 })

  // What is being answered: the newest message from the customer, and the thread's Message-ID chain.
  const { data: msgs, error: mErr } = await supabase.from('inbox_messages')
    .select('message_id, direction, from_email, from_name, text_body, created_at').eq('thread_id', thread.id).order('created_at', { ascending: true })
  if (mErr) return NextResponse.json({ error: mErr.message }, { status: 500 })
  const ids = (msgs ?? []).map((m: any) => m.message_id).filter((x: any): x is string => !!x)
  const lastIn = [...(msgs ?? [])].reverse().find((m: any) => m.direction === 'in')

  const rowId = crypto.randomUUID()
  const messageId = `${rowId}@globproxy.com`
  const fullText = buildReplyText(text, lastIn ? {
    text: lastIn.text_body ?? '',
    who: lastIn.from_name || lastIn.from_email,
    when: new Date(lastIn.created_at).toUTCString(),
  } : null)

  const { error: insErr } = await supabase.from('inbox_messages').insert({
    id: rowId, thread_id: thread.id, direction: 'out', message_id: messageId,
    in_reply_to: lastIn?.message_id ?? null, reference_ids: ids.slice(-20),
    from_email: 'support@globproxy.com', from_name: 'GlobProxy Support',
    to_emails: [thread.customer_email], subject: `Re: ${thread.subject} [GP-${thread.ticket_no}]`.slice(0, 300),
    text_body: text, sent_by: adminId, delivery_status: 'unknown',
  })
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })

  const sent = await sendThreadReply({
    to: thread.customer_email, threadSubject: thread.subject, ticketNo: Number(thread.ticket_no), text: fullText,
    inReplyTo: lastIn?.message_id ?? null, references: ids, idempotencyKey: rowId, messageId,
  })

  if (sent.ok) {
    await supabase.from('inbox_messages').update({ delivery_status: 'sent', provider_id: sent.providerId }).eq('id', rowId)
    // Waiting on the customer now; the sender owns the conversation if nobody did.
    await supabase.from('inbox_threads').update({
      status: 'pending', unread: false, ...(thread.assigned_to ? {} : { assigned_to: adminId }),
    }).eq('id', thread.id)
  } else if (!sent.unknown) {
    await supabase.from('inbox_messages').update({ delivery_status: 'failed', delivery_error: sent.error.slice(0, 300) }).eq('id', rowId)
  } else {
    await supabase.from('inbox_messages').update({ delivery_error: sent.error.slice(0, 300) }).eq('id', rowId)
  }

  await logAdminAction(supabase, {
    adminId, action: 'inbox.reply', targetUserId: thread.customer_user_id ?? null, targetRef: thread.id,
    // Length, not the text: the reply is customer correspondence kept on the thread.
    details: { ticket: thread.ticket_no, chars: text.length, delivery: sent.ok ? 'sent' : sent.unknown ? 'unknown' : 'failed' },
  })

  if (sent.ok) return NextResponse.json({ success: true })
  return NextResponse.json({
    error: sent.unknown
      ? 'The mail provider did not answer, so we cannot tell whether this was delivered. It is on the thread marked "delivery unknown" — check with the customer before sending it again.'
      : `The reply was not sent: ${sent.error}`,
    delivery: sent.unknown ? 'unknown' : 'failed',
  }, { status: sent.unknown ? 502 : 422 })
}
