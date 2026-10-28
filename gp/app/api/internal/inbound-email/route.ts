import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { validatePayload } from '@/lib/inboxCore'
import { ingestInbound } from '@/lib/inboxIngest'
import { notifyOperator } from '@/lib/inboxNotify'

// Called ONLY by the Worker's email() handler (custom-worker.ts), through the app's own fetch
// handler, with the same CRON_SECRET the scheduled() handler uses — nothing on the internet can
// reach it without that secret. The Worker has already parsed the MIME message; this stores it.
//
//   200 { status: 'stored' | 'duplicate' | 'ignored' | 'throttled' }   the Worker accepts the mail
//   4xx                                                                  the payload is unusable
//   5xx                                                                  the database failed: the Worker bounces
//                                                                        the message so the sender can retry
function authorized(req: Request): boolean {
  const secret = req.headers.get('x-cron-secret') ?? ''
  const expected = process.env.CRON_SECRET ?? ''
  if (!expected) return false
  const crypto = require('crypto')
  const a = Buffer.from(secret)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const raw = await req.json().catch(() => null)
  const parsed = validatePayload(raw)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  try {
    const supabase = await createAdminClient()
    const result = await ingestInbound(supabase, parsed.value)

    // Tell the operator: a brand-new human conversation always, and a customer's reply into an
    // existing one when the conversation was not already waiting unread (so a long back-and-forth
    // does not send a mail per message, but a reply to a closed or answered thread is never missed).
    // Automatic mail (out-of-office, bounces) never alerts. A failure here must not fail the delivery.
    if (result.status === 'stored' && !result.auto && (result.newThread || !result.wasUnread)) {
      await notifyOperator(result.newThread ? 'new' : 'reply', {
        customerEmail: result.customerEmail, subject: result.subject, threadId: result.threadId,
      }).catch((e) => console.error('[inbound-email] admin notice failed', e))
    }
    return NextResponse.json({ status: result.status, ...(result.status !== 'stored' ? { reason: result.reason } : {}) })
  } catch (e) {
    console.error('[inbound-email] could not store a message', e)
    return NextResponse.json({ error: 'Could not store the message.' }, { status: 500 })
  }
}
