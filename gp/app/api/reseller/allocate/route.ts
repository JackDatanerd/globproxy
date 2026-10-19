import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { requireMfaVerified } from '@/lib/mfa'
import { rateLimited } from '@/lib/rateLimit'
import { sendEmail, escapeHtml } from '@/lib/email'
import { dispatchWebhook } from '@/lib/webhooks'
import { cleanText, cleanNumber } from '@/lib/validation'
import { formatGb } from '@/lib/format'
import { NextResponse } from 'next/server'

const MIN_ALLOCATION_GB = 0.1

export async function POST(req: Request) {
  try {
    // ── Auth: reseller or admin only ────────────────────────────────────────
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles').select('role, email, full_name').eq('id', user.id).single()
    if (!['reseller', 'admin'].includes(profile?.role ?? '')) {
      return NextResponse.json({ error: 'Reseller access required' }, { status: 403 })
    }

    const mfaCheck = await requireMfaVerified(req, user.id)
    if (mfaCheck) return mfaCheck

    const senderSuspended = await requireActiveUser(user.id)
    if (senderSuspended) return senderSuspended

    // Per-reseller throttle. Each call can email an arbitrary registered
    // address, so without this a reseller could use dust-sized allocations as
    // an unmetered email cannon, or probe which emails are registered.
    const limited = await rateLimited(req, 'RESELLER_RATE_LIMITER', `allocate:${user.id}`)
    if (limited) return limited

    // ── Payload validation ──────────────────────────────────────────────────
    // The old check was `!gb_allocated || gb_allocated <= 0`, which let strings
    // and NaN through to the database cast and threw on non-string emails.
    let body: any
    try { body = await req.json() } catch { body = null }
    const recipientEmail = cleanText(body?.recipient_email, 254)?.toLowerCase() ?? null
    const gb = cleanNumber(body?.gb_allocated)
    const note = body?.note === undefined || body?.note === null || body?.note === '' ? null : cleanText(body.note, 200)

    if (!recipientEmail || !recipientEmail.includes('@')) {
      return NextResponse.json({ error: 'A valid recipient email is required' }, { status: 400 })
    }
    if (gb === null || gb < MIN_ALLOCATION_GB) {
      return NextResponse.json({ error: `Enter an amount of at least ${MIN_ALLOCATION_GB} GB` }, { status: 400 })
    }
    if (gb > 1_000_000 || Math.abs(gb * 1000 - Math.round(gb * 1000)) > 1e-6) {
      return NextResponse.json({ error: 'Use at most 3 decimal places (and a sensible amount)' }, { status: 400 })
    }
    if (body?.note !== undefined && body?.note !== null && body?.note !== '' && note === null) {
      return NextResponse.json({ error: 'Note must be text up to 200 characters' }, { status: 400 })
    }
    const gbAmount = Math.round(gb * 1000) / 1000

    const adminSupabase = await createAdminClient()

    // ── 1. Find recipient ───────────────────────────────────────────────────
    const { data: recipientProfile } = await adminSupabase
      .from('profiles')
      .select('id, email, full_name, is_deleted, is_suspended')
      .eq('email', recipientEmail)
      .maybeSingle()

    // One answer for missing / deleted / suspended: the three distinct messages
    // used to let any reseller learn exactly which emails are registered and
    // which of those accounts are suspended.
    if (!recipientProfile || recipientProfile.is_deleted || recipientProfile.is_suspended) {
      return NextResponse.json(
        { error: 'No active GlobProxy account found for that email. They must sign up first, and their account must be in good standing.' },
        { status: 404 }
      )
    }
    if (recipientProfile.id === user.id) {
      return NextResponse.json({ error: 'Cannot allocate bandwidth to yourself.' }, { status: 400 })
    }

    // ── 2. Atomically check stock, move it, and write the history row ───────
    // allocate_reseller_bandwidth_tx (migration 0039) does all three in ONE
    // transaction. History used to be a separate, "non-fatal" insert, so a
    // failed write left bandwidth moved with no record of it.
    const { data: rpcResult, error: rpcError } = await adminSupabase
      .rpc('allocate_reseller_bandwidth_tx', {
        p_reseller_id: user.id,
        p_recipient_id: recipientProfile.id,
        p_gb: gbAmount,
        p_note: note,
      })

    if (rpcError) {
      const msg = rpcError.message ?? ''
      if (msg.includes('Not enough bandwidth')) return NextResponse.json({ error: 'Not enough bandwidth in your stock.' }, { status: 400 })
      if (msg.includes('yourself')) return NextResponse.json({ error: 'Cannot allocate bandwidth to yourself.' }, { status: 400 })
      if (msg.includes('Minimum allocation') || msg.includes('decimal places') || msg.includes('too large')) {
        return NextResponse.json({ error: msg }, { status: 400 })
      }
      console.error('[reseller/allocate] RPC failed', rpcError)
      return NextResponse.json({ error: 'Failed to complete transfer.' }, { status: 500 })
    }
    const transferId = Array.isArray(rpcResult) ? rpcResult[0]?.transfer_id : (rpcResult as any)?.transfer_id

    // Webhook for the recipient: bandwidth landed on their account. Awaited and
    // never throws (see lib/webhooks.ts).
    await dispatchWebhook(recipientProfile.id, 'bandwidth_credited', {
      gb_credited: gbAmount, source: 'reseller_allocation',
    })

    // ── 3. Notify both sides (best-effort; the transfer is already committed)
    const gbLabel = escapeHtml(formatGb(gbAmount))
    const senderName = escapeHtml(profile?.full_name?.split(' ')[0]) || 'there'
    const safeRecipient = escapeHtml(recipientEmail)
    const appUrl = process.env.NEXT_PUBLIC_APP_URL

    await Promise.allSettled([
      profile?.email
        ? sendEmail({
            to: profile.email,
            subject: `Confirmed: ${formatGb(gbAmount)} transferred to ${recipientEmail}`,
            html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
            <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
              style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
            <h2 style="text-align:center;color:#111;">Transfer confirmed ✓</h2>
            <p style="color:#444;text-align:center;">
              Hi ${senderName}, you've transferred <strong>${gbLabel}</strong> to
              ${safeRecipient}. It's been deducted from your available stock
              and is now active on their account. If it was a mistake, you can reclaim any part
              they haven't used yet from your transfer history.
            </p>
            <div style="text-align:center;margin:32px 0;">
              <a href="${appUrl}/reseller/transfers"
                 style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
                View transfer history →
              </a>
            </div>
            <p style="color:#bbb;font-size:12px;text-align:center;margin-top:32px;">
              © 2026 GlobProxy · Residential Proxies That Never Expire
            </p>
          </div>
        `,
          })
        : Promise.resolve(),
      recipientProfile.email
        ? sendEmail({
            to: recipientProfile.email,
            subject: `${formatGb(gbAmount)} of bandwidth was added to your account`,
            html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
            <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
              style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
            <h2 style="text-align:center;color:#111;">Bandwidth added ✓</h2>
            <p style="color:#444;text-align:center;">
              Hi ${escapeHtml(recipientProfile.full_name?.split(' ')[0]) || 'there'},
              <strong>${gbLabel}</strong> has been added to your GlobProxy account by
              ${escapeHtml(profile?.full_name) || escapeHtml(user.email) || 'your reseller'}.
              It's ready to use now.
            </p>
            <div style="text-align:center;margin:32px 0;">
              <a href="${appUrl}/dashboard"
                 style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
                Go to dashboard →
              </a>
            </div>
            <p style="color:#bbb;font-size:12px;text-align:center;margin-top:32px;">
              © 2026 GlobProxy · Residential Proxies That Never Expire
            </p>
          </div>
        `,
          })
        : Promise.resolve(),
    ]).then(results => results.forEach(r => { if (r.status === 'rejected') console.error('[reseller/allocate] email failed:', r.reason) }))

    return NextResponse.json({
      success: true,
      transfer_id: transferId ?? null,
      message: `Successfully transferred ${formatGb(gbAmount)} to ${recipientEmail}`,
    })

  } catch (err: any) {
    console.error('Allocation error:', err)
    return NextResponse.json({ error: 'Failed to complete transfer.' }, { status: 500 })
  }
}
