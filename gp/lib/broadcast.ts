import { createAdminClient } from '@/lib/supabase/server'
import { sendEmail, sendEmailBatch } from '@/lib/email'
import { appUrl } from '@/lib/appUrl'
import { renderBroadcastEmail, classifySendStatus, type BroadcastKind } from '@/lib/broadcastRules'
import { unsubscribeUrl } from '@/lib/unsubscribe'

// Sends admin broadcasts (supabase/migrations/0108_broadcasts.sql, lib/broadcastRules.ts).
//
// An admin pressing "Send" only records the message and snapshots the audience; the e-mails go out
// from here, 100 per provider call, a few calls per 5-minute tick (and on demand from the admin
// screen). Who may be messaged is decided by the database at the moment each batch is claimed, so
// an account suspended, banned, deleted or opted out since the snapshot is skipped, not mailed.
//
// Safety properties, each covered by tests/broadcast.test.mjs:
//   * a recipient is only ever 'sent' after the provider accepted their batch;
//   * the provider did not take it (429 / 5xx) -> back to 'pending', at most 4 attempts;
//   * no answer at all (timeout) -> 'failed', never silently re-sent: it may have been delivered;
//   * a rejection about the content -> 'failed' with the provider's reason, and the heartbeat goes red;
//   * a bad API key / unverified domain stops the run and puts the batch back untouched.

export const BATCH_SIZE = 100
export const MAX_ATTEMPTS = 4
const DEFAULT_BATCHES_PER_RUN = 4

export interface BroadcastRow {
  id: string
  kind: BroadcastKind
  subject: string
  body: string
  cta_label: string | null
  cta_url: string | null
  recipient_count: number
}

/** Key for the unsubscribe links. A dedicated UNSUBSCRIBE_SECRET if one is set, else the cron secret
 *  (always present in production). Empty = marketing mail cannot be sent. */
export function unsubscribeSecret(): string {
  return process.env.UNSUBSCRIBE_SECRET?.trim() || process.env.CRON_SECRET?.trim() || ''
}

const SUPPORT_MAILTO = 'mailto:support@globproxy.com?subject=unsubscribe'

async function buildMessage(b: Pick<BroadcastRow, 'kind' | 'subject' | 'body' | 'cta_label' | 'cta_url'>, r: { user_id: string; email: string; full_name: string | null }, subjectPrefix = '') {
  const marketing = b.kind === 'marketing'
  const unsub = marketing ? await unsubscribeUrl(appUrl(), unsubscribeSecret(), r.user_id) : null
  return {
    to: r.email,
    subject: `${subjectPrefix}${b.subject}`,
    html: renderBroadcastEmail({
      kind: b.kind, subject: b.subject, body: b.body, ctaLabel: b.cta_label, ctaUrl: b.cta_url,
      fullName: r.full_name, unsubscribeUrl: unsub,
    }),
    // One-click unsubscribe (RFC 8058): the mail client's own "Unsubscribe" button. Marketing only — a
    // service notice cannot be opted out of, so it must not advertise that it can.
    ...(unsub ? { headers: { 'List-Unsubscribe': `<${unsub}>, <${SUPPORT_MAILTO}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } : {}),
  }
}

/** One copy of the message to the admin who is writing it, exactly as a customer would get it. */
export async function sendBroadcastTest(
  b: Pick<BroadcastRow, 'kind' | 'subject' | 'body' | 'cta_label' | 'cta_url'>,
  to: { user_id: string; email: string; full_name: string | null },
): Promise<{ ok: boolean; error?: string }> {
  if (b.kind === 'marketing' && !unsubscribeSecret()) return { ok: false, error: 'No unsubscribe secret is configured (UNSUBSCRIBE_SECRET or CRON_SECRET), so marketing e-mail cannot be sent.' }
  try {
    const msg = await buildMessage(b, to, '[TEST] ')
    const res = await sendEmail({ ...msg, idempotencyKey: crypto.randomUUID() })
    return res.ok ? { ok: true } : { ok: false, error: `The e-mail provider answered ${res.status}.` }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) }
  }
}

async function shortHash(input: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(d)).slice(0, 8).map(x => x.toString(16).padStart(2, '0')).join('')
}

type Admin = Awaited<ReturnType<typeof createAdminClient>>

async function setStatus(supabase: Admin, broadcastId: string, ids: string[], patch: Record<string, unknown>, extra?: (q: any) => any) {
  if (!ids.length) return null
  let q: any = supabase.from('broadcast_recipients').update(patch).eq('broadcast_id', broadcastId).eq('status', 'sending').in('user_id', ids)
  if (extra) q = extra(q)
  const { error } = await q
  return error ? error.message : null
}

/** Sends one claimed batch and records what happened to each recipient. */
async function deliverBatch(
  supabase: Admin, b: BroadcastRow, claimed: Array<{ user_id: string; email: string; full_name: string | null }>,
): Promise<{ sent: number; failed: number; requeued: number; stop?: string; problem?: string }> {
  const ids = claimed.map(r => r.user_id)
  let items: Awaited<ReturnType<typeof buildMessage>>[]
  try {
    items = await Promise.all(claimed.map(r => buildMessage(b, r)))
  } catch (e) {
    // A message that cannot be built would fail identically on every tick: fail these rows visibly
    // instead of leaving them to be re-claimed forever.
    const why = String((e as Error)?.message ?? e).slice(0, 120)
    const p = await setStatus(supabase, b.id, ids, { status: 'failed', reason: `could not build message: ${why}` })
    return { sent: 0, failed: ids.length, requeued: 0, problem: `could not build message: ${why}${p ? ` / ${p}` : ''}` }
  }
  const key = `bc-${b.id}-${await shortHash([...ids].sort().join(','))}`
  const res = await sendEmailBatch(items, { idempotencyKey: key })
  const outcome = classifySendStatus(res.status)
  const nowIso = new Date().toISOString()
  let dbProblem: string | null = null

  if (outcome === 'sent') {
    dbProblem = await setStatus(supabase, b.id, ids, { status: 'sent', sent_at: nowIso, reason: null })
    return { sent: ids.length, failed: 0, requeued: 0, ...(dbProblem ? { problem: `sent but could not be recorded: ${dbProblem}` } : {}) }
  }
  if (outcome === 'retry') {
    // The provider did not take it: safe to try again, up to MAX_ATTEMPTS.
    const p1 = await setStatus(supabase, b.id, ids, { status: 'pending', reason: `retry: provider answered ${res.status}` }, q => q.lt('attempts', MAX_ATTEMPTS))
    const p2 = await setStatus(supabase, b.id, ids, { status: 'failed', reason: `gave up: provider answered ${res.status}` }, q => q.gte('attempts', MAX_ATTEMPTS))
    return { sent: 0, failed: 0, requeued: ids.length, ...(p1 || p2 ? { problem: p1 ?? p2 ?? undefined } : {}) }
  }
  if (outcome === 'config') {
    // Nothing is wrong with these people: put the batch back untouched and stop the whole run.
    await setStatus(supabase, b.id, ids, { status: 'pending', reason: null, attempts: 0 })
    return { sent: 0, failed: 0, requeued: ids.length, stop: `the e-mail provider refused our credentials (${res.status}) — check RESEND_API_KEY and the sending domain` }
  }
  if (outcome === 'rejected') {
    dbProblem = await setStatus(supabase, b.id, ids, { status: 'failed', reason: `rejected (${res.status}): ${String(res.detail ?? '').slice(0, 160)}` })
    return { sent: 0, failed: ids.length, requeued: 0, problem: `batch rejected (${res.status}): ${String(res.detail ?? '').slice(0, 160)}${dbProblem ? ` / ${dbProblem}` : ''}` }
  }
  // 'unconfirmed': no answer. It may have been delivered, so it is NOT retried automatically.
  dbProblem = await setStatus(supabase, b.id, ids, { status: 'failed', reason: 'interrupted: delivery unconfirmed' })
  return { sent: 0, failed: ids.length, requeued: 0, problem: `no answer from the e-mail provider — ${ids.length} recipients marked failed, not re-sent automatically${dbProblem ? ` / ${dbProblem}` : ''}` }
}

/** Cron entry (every 5 minutes) and the admin screen's "send now". Never throws: a failure is returned
 *  as `error` so the heartbeat records it. Safe to run twice at once — each batch is claimed with
 *  FOR UPDATE SKIP LOCKED. */
export async function runBroadcasts(opts: { maxBatches?: number; onlyId?: string } = {}) {
  const out = { enqueued: 0, sent: 0, failed: 0, requeued: 0, batches: 0, broadcasts: 0 } as Record<string, unknown> & { sent: number; failed: number; requeued: number; batches: number; broadcasts: number; enqueued: number }
  const problems: string[] = []
  const finish = () => (problems.length ? { ...out, error: problems.slice(0, 4).join('; ') } : out)
  try {
    const supabase = await createAdminClient()

    // Housekeeping: a year-old finished broadcast and its recipient rows have no further use.
    if (!opts.onlyId) {
      const cutoff = new Date(Date.now() - 365 * 86_400_000).toISOString()
      const { error } = await supabase.from('broadcasts').delete().in('status', ['done', 'cancelled']).lt('created_at', cutoff)
      if (error) problems.push(`retention sweep failed: ${error.message}`)
    }

    let q = supabase.from('broadcasts').select('id, kind, subject, body, cta_label, cta_url, recipient_count').eq('status', 'sending').order('created_at', { ascending: true }).limit(5)
    if (opts.onlyId) q = q.eq('id', opts.onlyId)
    const { data: list, error: listErr } = await q
    if (listErr) { problems.push(`could not list broadcasts: ${listErr.message}`); return finish() }

    let batchesLeft = Math.max(1, opts.maxBatches ?? DEFAULT_BATCHES_PER_RUN)
    for (const b of (list ?? []) as BroadcastRow[]) {
      if (batchesLeft <= 0) break
      out.broadcasts++

      // Recorded but never snapshotted (the request that created it died between the two steps).
      if (!b.recipient_count) {
        const { data: n, error } = await supabase.rpc('broadcast_enqueue', { p_broadcast: b.id })
        if (error) { problems.push(`enqueue failed for ${b.id}: ${error.message}`); continue }
        out.enqueued += Number(n ?? 0)
      }
      if (b.kind === 'marketing' && !unsubscribeSecret()) {
        problems.push('marketing e-mail cannot be sent: no unsubscribe secret (UNSUBSCRIBE_SECRET or CRON_SECRET)')
        return finish()
      }

      for (let guard = 0; batchesLeft > 0 && guard < 20; guard++) {
        const { data: claimed, error } = await supabase.rpc('broadcast_claim', { p_broadcast: b.id, p_limit: BATCH_SIZE })
        if (error) { problems.push(`claim failed for ${b.id}: ${error.message}`); break }
        const rows = (claimed ?? []) as Array<{ user_id: string; email: string; full_name: string | null }>
        if (rows.length === 0) {
          // Either finished, or every row in that slice was skipped (no longer eligible / opted out): look again.
          const { count } = await supabase.from('broadcast_recipients').select('*', { count: 'exact', head: true }).eq('broadcast_id', b.id).eq('status', 'pending')
          if (!count) break
          continue
        }
        batchesLeft--
        out.batches++
        const r = await deliverBatch(supabase, b, rows)
        out.sent += r.sent; out.failed += r.failed; out.requeued += r.requeued
        if (r.problem) problems.push(r.problem)
        if (r.stop) { problems.push(r.stop); return finish() }
        if (r.requeued) break // the provider is struggling: leave the rest for the next tick
      }
    }
    return finish()
  } catch (e: any) {
    console.error('[cron broadcasts] failed:', e)
    problems.push(String(e?.message ?? e))
    return finish()
  }
}
