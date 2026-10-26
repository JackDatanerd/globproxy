import PostalMime from 'postal-mime'
import { MAX_TEXT_CHARS, normalizeAddress, type InboundPayload } from './inboxCore'

// The MIME half of the inbox, kept out of custom-worker.ts so it can be tested with real messages
// (tests/inbox.test.mjs): turns the raw RFC 822 bytes Cloudflare Email Routing hands the Worker
// into the compact JSON /api/internal/inbound-email stores. Relative imports only — this file also
// runs under plain Node in the tests.

// The headers the ingest rules look at. Everything else is dropped on the way in.
const KEPT_HEADERS = new Set([
  'auto-submitted', 'precedence', 'x-autoreply', 'x-autorespond', 'x-auto-response-suppress',
  'list-id', 'list-unsubscribe', 'content-type',
])

type Mailbox = { name?: string; address?: string; group?: Mailbox[] }

function flatten(list: Mailbox[] | undefined): string[] {
  const out: string[] = []
  for (const a of list ?? []) {
    if (a.group) out.push(...flatten(a.group))
    else if (a.address) { const n = normalizeAddress(a.address); if (n) out.push(n) }
  }
  return out
}

export async function parseInboundMime(
  raw: ArrayBuffer | Uint8Array, envelope: { from: string; to: string },
): Promise<InboundPayload> {
  const email = await PostalMime.parse(raw, { maxNestingDepth: 20, maxPartCount: 200, maxHeadersSize: 256 * 1024 })
  const headers: Record<string, string> = {}
  for (const h of email.headers ?? []) {
    const k = String(h.key ?? '').toLowerCase()
    if (KEPT_HEADERS.has(k) && !(k in headers)) headers[k] = String(h.value ?? '').slice(0, 300)
  }
  const fromAddr = (email.from && !('group' in email.from && email.from.group) ? email.from.address : undefined) ?? undefined
  const text = (email.text ?? '').slice(0, MAX_TEXT_CHARS * 2)
  return {
    envelope_to: envelope.to,
    envelope_from: envelope.from,
    message_id: email.messageId ?? null,
    in_reply_to: email.inReplyTo ?? null,
    references: email.references ?? null,
    from: fromAddr ? { address: fromAddr, name: email.from?.name ?? '' } : null,
    to: flatten(email.to as Mailbox[] | undefined),
    cc: flatten(email.cc as Mailbox[] | undefined),
    subject: email.subject ?? null,
    text,
    // HTML is only a reading fallback when there is no text part; it is never stored or rendered.
    html: text.trim() ? (email.html ? '<html-present/>' : null) : (email.html ?? null),
    headers,
    attachments: (email.attachments ?? []).slice(0, 50).map((a) => ({
      filename: a.filename ?? null,
      mime_type: a.mimeType || 'application/octet-stream',
      size: typeof a.content === 'string' ? a.content.length : (a.content as ArrayBuffer).byteLength ?? 0,
    })),
    date: email.date ?? null,
  }
}

// When the MIME cannot be read at all, the message is still worth showing: the envelope and the
// first few headers are known, the body is not.
export function unreadablePayload(envelope: { from: string; to: string }, subject: string | null, messageId: string | null): InboundPayload {
  return {
    envelope_to: envelope.to, envelope_from: envelope.from,
    message_id: messageId, in_reply_to: null, references: null,
    from: normalizeAddress(envelope.from) ? { address: envelope.from, name: '' } : null,
    to: [envelope.to], cc: [], subject,
    text: '(This message could not be read automatically. Ask the sender to resend it as plain text.)',
    html: null, headers: {}, attachments: [], date: null,
  }
}
