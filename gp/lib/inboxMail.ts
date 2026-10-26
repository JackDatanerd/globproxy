import { quoteForReply, replySubject } from '@/lib/inboxCore'

// Outbound mail from the shared inbox. It goes through Resend like every other e-mail in the app,
// but from support@ (not the no-reply address) and with the threading headers a mail client needs
// to keep the conversation together. Plain text only: a person answering a person.
export const SUPPORT_FROM = 'GlobProxy Support <support@globproxy.com>'
const SIGNATURE = '\n\n—\nGlobProxy Support\nsupport@globproxy.com'

export type OutboundResult =
  | { ok: true; messageId: string; providerId: string | null }
  | { ok: false; unknown: boolean; error: string } // unknown: the provider may still have sent it

export function buildReplyText(body: string, quoted?: { text: string; who: string; when: string } | null): string {
  const q = quoted?.text.trim() ? `\n\n${quoteForReply(quoted.text, quoted.who, quoted.when)}` : ''
  return `${body.trim()}${SIGNATURE}${q}`
}

export async function sendThreadReply(p: {
  to: string
  threadSubject: string
  ticketNo: number
  text: string
  inReplyTo: string | null      // Message-ID of the message being answered (no brackets)
  references: string[]          // earlier Message-IDs of the thread, oldest first
  idempotencyKey: string
  messageId: string             // the Message-ID this mail goes out with (no brackets), stored with it
}): Promise<OutboundResult> {
  if (!process.env.RESEND_API_KEY) return { ok: false, unknown: false, error: 'RESEND_API_KEY is not configured' }
  const messageId = p.messageId
  const refs = [...new Set([...p.references, ...(p.inReplyTo ? [p.inReplyTo] : [])])].slice(-20)
  let res: Response
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': p.idempotencyKey,
      },
      body: JSON.stringify({
        from: SUPPORT_FROM,
        to: p.to,
        reply_to: 'support@globproxy.com',
        subject: replySubject(p.threadSubject, p.ticketNo),
        text: p.text,
        headers: {
          'Message-ID': `<${messageId}>`,
          ...(p.inReplyTo ? { 'In-Reply-To': `<${p.inReplyTo}>` } : {}),
          ...(refs.length ? { References: refs.map((r) => `<${r}>`).join(' ') } : {}),
        },
      }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e: any) {
    // No answer: the provider may have accepted it. Never "failed" — the caller shows "check before resending".
    return { ok: false, unknown: true, error: `No answer from the mail provider: ${e?.message ?? e}` }
  }
  if (res.status >= 500 || res.status === 429) return { ok: false, unknown: res.status >= 500, error: `The mail provider answered ${res.status}` }
  const data: any = await res.json().catch(() => ({}))
  if (!res.ok) return { ok: false, unknown: false, error: String(data?.message ?? `The mail provider answered ${res.status}`).slice(0, 300) }
  return { ok: true, messageId, providerId: typeof data?.id === 'string' ? data.id : null }
}
