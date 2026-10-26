import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { validatePayload } from '@/lib/inboxCore'
import { ingestInbound } from '@/lib/inboxIngest'
import { sendEmail, escapeHtml } from '@/lib/email'
import { appUrl } from '@/lib/appUrl'
import { INBOX_ADDRESSES } from '@/lib/inboxCore'

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

    // A brand-new human conversation: tell the operator once. Never to an inbox address (that
    // would feed this very handler), and a failure here must not fail the delivery.
    if (result.status === 'stored' && result.newThread && !result.auto) {
      const to = process.env.ADMIN_EMAIL
      if (to && !(INBOX_ADDRESSES as readonly string[]).includes(to.trim().toLowerCase())) {
        await sendEmail({
          to,
          subject: `[INBOX] New message from ${result.customerEmail}`.replace(/[\r\n]+/g, ' '),
          html: `<p><strong>${escapeHtml(result.customerEmail)}</strong> wrote to support@globproxy.com:</p>
                 <p>${escapeHtml(result.subject)}</p>
                 <p><a href="${appUrl()}/admin/inbox/${result.threadId}">Open in the inbox →</a></p>`,
        }).catch((e) => console.error('[inbound-email] admin notice failed', e))
      }
    }
    return NextResponse.json({ status: result.status, ...(result.status !== 'stored' ? { reason: result.reason } : {}) })
  } catch (e) {
    console.error('[inbound-email] could not store a message', e)
    return NextResponse.json({ error: 'Could not store the message.' }, { status: 500 })
  }
}
