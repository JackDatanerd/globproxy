import { authorizeAdmin, readJson, badRequest, isUuid } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { appUrl } from '@/lib/appUrl'
import { leaksSupplier } from '@/lib/supplierGuard'
import { validateAudience, validateContent, type Audience, type BroadcastContent } from '@/lib/broadcastRules'
import { sendBroadcastTest, runBroadcasts } from '@/lib/broadcast'
import { NextResponse } from 'next/server'

// Admin broadcasts: message every customer, a group, or a pasted list of addresses by e-mail and/or a
// dashboard banner. Delivery itself is lib/broadcast.ts (cron, 100 per provider call).
//
//   preview  { audience, kind }                 who it would reach, before anything is sent
//   test     { content }                        one copy, to the admin's own address
//   send     { requestId, audience, content, confirm: { eligible, emailable } }
//   cancel   { id }                             stop unsent e-mail and/or withdraw the banner
//   retry    { id }                             put failed recipients back in the queue (may re-send an
//                                               "unconfirmed" one: the admin is told so)
//   kick     { id }                             send a few batches now instead of waiting for the next tick
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth
  const body = await readJson<any>(req)
  if (!body || typeof body.action !== 'string') return badRequest('Invalid request')
  const origin = appUrl()

  // The audience and content are validated by the same functions the form uses.
  type Parsed = { error: string } | { error?: undefined; audience: Audience; content: BroadcastContent }
  const parseCommon = (): Parsed => {
    const aud = validateAudience(body.audience)
    if (!aud.ok) return { error: aud.error }
    const content = validateContent(body.content, { origin })
    if (!content.ok) return { error: content.error }
    // Our upstream supplier must never appear in anything a customer reads.
    const c = content.value
    if ([c.subject, c.body, c.ctaLabel, c.ctaUrl].some(leaksSupplier)) return { error: 'This message names our upstream provider. Remove it before sending.' }
    return { audience: aud.value, content: c }
  }

  switch (body.action) {
    case 'preview': {
      const aud = validateAudience(body.audience)
      if (!aud.ok) return badRequest(aud.error)
      const kind = body.kind === 'service' ? 'service' : 'marketing'
      const { data, error } = await supabase.rpc('broadcast_preview', { p_audience: aud.value, p_kind: kind })
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ success: true, preview: data })
    }

    case 'test': {
      const p = parseCommon()
      if (p.error !== undefined) return badRequest(p.error)
      const { data: me } = await supabase.from('profiles').select('email, full_name').eq('id', adminId).maybeSingle()
      if (!me?.email) return badRequest('Your account has no e-mail address to send the test to')
      const r = await sendBroadcastTest(
        { kind: p.content.kind, subject: p.content.subject, body: p.content.body, cta_label: p.content.ctaLabel, cta_url: p.content.ctaUrl },
        { user_id: adminId, email: me.email, full_name: me.full_name ?? null },
      )
      if (!r.ok) return NextResponse.json({ error: r.error ?? 'The test e-mail could not be sent' }, { status: 502 })
      return NextResponse.json({ success: true, sent_to: me.email })
    }

    case 'send': {
      const p = parseCommon()
      if (p.error !== undefined) return badRequest(p.error)
      const requestId = typeof body.requestId === 'string' && /^[0-9a-f-]{36}$/i.test(body.requestId) ? body.requestId : null
      if (!requestId) return badRequest('Missing request id — reload the page and try again')

      // A repeat of the same press (double click, retry after a lost answer) returns the original.
      const { data: existing } = await supabase.from('broadcasts').select('id, recipient_count').eq('request_id', requestId).maybeSingle()
      if (existing) return NextResponse.json({ success: true, id: existing.id, recipients: existing.recipient_count, duplicate: true })

      const kind = p.content.kind
      const { data: prev, error: pErr } = await supabase.rpc('broadcast_preview', { p_audience: p.audience, p_kind: kind })
      if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 })
      const eligible = Number(prev?.eligible ?? 0), emailable = Number(prev?.emailable ?? 0)
      if (eligible === 0) return badRequest('No account matches that audience, so there is no one to send to')
      if (p.content.sendEmail && emailable === 0 && !p.content.showBanner) return badRequest('Everyone in that audience has opted out of product news, so nothing would be sent')
      // The admin confirmed specific numbers. If the audience moved since (someone signed up, opted out, was
      // banned), say so and make them look again rather than send to a different group than the one they approved.
      if (Number(body?.confirm?.eligible) !== eligible || Number(body?.confirm?.emailable) !== emailable) {
        return NextResponse.json({ error: 'The audience changed since you previewed it. Review the new numbers and confirm again.', preview: prev }, { status: 409 })
      }

      const { data: row, error: insErr } = await supabase.from('broadcasts').insert({
        request_id: requestId, kind, subject: p.content.subject, body: p.content.body,
        cta_label: p.content.ctaLabel, cta_url: p.content.ctaUrl, audience: p.audience,
        send_email: p.content.sendEmail, show_banner: p.content.showBanner, banner_ends_at: p.content.bannerEndsAt,
        created_by: adminId,
      }).select('id').single()
      if (insErr || !row) {
        if ((insErr as any)?.code === '23505') {
          const { data: again } = await supabase.from('broadcasts').select('id, recipient_count').eq('request_id', requestId).maybeSingle()
          if (again) return NextResponse.json({ success: true, id: again.id, recipients: again.recipient_count, duplicate: true })
        }
        return NextResponse.json({ error: insErr?.message ?? 'Could not record the broadcast' }, { status: 500 })
      }

      const { data: n, error: enqErr } = await supabase.rpc('broadcast_enqueue', { p_broadcast: row.id })
      // If this fails the row stays 'sending' with no recipients and the next cron tick finishes the job.
      await logAdminAction(supabase, {
        adminId, action: 'broadcast.send', targetRef: row.id,
        details: { kind, subject: p.content.subject, audience: p.audience.kind, eligible, emailable, email: p.content.sendEmail, banner: p.content.showBanner, enqueue_error: enqErr?.message ?? null },
      })
      return NextResponse.json({ success: true, id: row.id, recipients: Number(n ?? eligible), enqueue_pending: !!enqErr })
    }

    case 'cancel': {
      if (!isUuid(body.id)) return badRequest('Missing or invalid broadcast id')
      const now = new Date().toISOString()
      const { data, error } = await supabase.from('broadcasts')
        .update({ status: 'cancelled', cancelled_at: now, finished_at: now })
        .eq('id', body.id).in('status', ['sending', 'done']).select('id')
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      if (!data?.length) return badRequest('That broadcast is already stopped')
      await logAdminAction(supabase, { adminId, action: 'broadcast.cancel', targetRef: body.id, details: {} })
      return NextResponse.json({ success: true })
    }

    case 'retry': {
      if (!isUuid(body.id)) return badRequest('Missing or invalid broadcast id')
      const { data: b } = await supabase.from('broadcasts').select('id, status').eq('id', body.id).maybeSingle()
      if (!b) return badRequest('Broadcast not found')
      if (b.status === 'cancelled') return badRequest('A stopped broadcast cannot be retried')
      const { data: moved, error } = await supabase.from('broadcast_recipients')
        .update({ status: 'pending', reason: null, attempts: 0, claimed_at: null }).eq('broadcast_id', b.id).eq('status', 'failed').select('user_id')
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      if (moved?.length && b.status === 'done') await supabase.from('broadcasts').update({ status: 'sending', finished_at: null }).eq('id', b.id).eq('status', 'done')
      await logAdminAction(supabase, { adminId, action: 'broadcast.retry', targetRef: b.id, details: { requeued: moved?.length ?? 0 } })
      return NextResponse.json({ success: true, requeued: moved?.length ?? 0 })
    }

    case 'kick': {
      if (!isUuid(body.id)) return badRequest('Missing or invalid broadcast id')
      const result = await runBroadcasts({ onlyId: body.id, maxBatches: 3 })
      // A failed run must not look like a success to the button (adminPost only reads a top-level `error`).
      if ('error' in result && result.error) return NextResponse.json({ error: String(result.error), result }, { status: 502 })
      return NextResponse.json({ success: true, result })
    }

    default:
      return badRequest('Unknown action')
  }
}
