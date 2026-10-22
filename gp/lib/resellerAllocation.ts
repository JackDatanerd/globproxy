import { applyCursor } from '@/lib/cursor'
import { createAdminClient } from '@/lib/supabase/server'
import { sendEmail, escapeHtml } from '@/lib/email'
import { dispatchWebhook } from '@/lib/webhooks'
import { cleanText, cleanNumber } from '@/lib/validation'
import { isUuid } from '@/lib/adminAuth'
import { formatGb } from '@/lib/format'
import { appUrl as getAppUrl } from '@/lib/appUrl'

// The single implementation of reseller → client bandwidth allocation and
// reclaim. Shared by the dashboard routes (/api/reseller/allocate, /reclaim —
// session auth + 2FA) and the public API (/api/v1/reseller/*, `allocate`-scope
// keys), so the stock check, the atomic transfer, the notifications and the
// webhooks can never drift apart between the two entry points. Authentication,
// 2FA, throttling and request parsing stay with the caller; everything from
// "validated input" onward lives here.
type Admin = Awaited<ReturnType<typeof createAdminClient>>

export const MIN_ALLOCATION_GB = 0.1

export type AllocFail = { ok: false; status: number; code: 'invalid_request' | 'not_found' | 'conflict' | 'insufficient_bandwidth' | 'internal_error'; message: string }
export type AllocResult<T> = { ok: true; data: T } | AllocFail
const fail = (status: number, code: AllocFail['code'], message: string): AllocFail => ({ ok: false, status, code, message })

export type Reseller = { id: string; email?: string | null; full_name?: string | null }

// ── Allocate ──────────────────────────────────────────────────────────
export function parseAllocationBody(body: any): AllocResult<{ recipientEmail: string; gbAmount: number; note: string | null }> {
  // The old check was `!gb_allocated || gb_allocated <= 0`, which let strings
  // and NaN through to the database cast and threw on non-string emails.
  const recipientEmail = cleanText(body?.recipient_email, 254)?.toLowerCase() ?? null
  const gb = cleanNumber(body?.gb_allocated)
  const note = body?.note === undefined || body?.note === null || body?.note === '' ? null : cleanText(body.note, 200)

  if (!recipientEmail || !recipientEmail.includes('@')) return fail(400, 'invalid_request', 'A valid recipient email is required')
  if (gb === null || gb < MIN_ALLOCATION_GB) return fail(400, 'invalid_request', `Enter an amount of at least ${MIN_ALLOCATION_GB} GB`)
  if (gb > 1_000_000 || Math.abs(gb * 1000 - Math.round(gb * 1000)) > 1e-6) return fail(400, 'invalid_request', 'Use at most 3 decimal places (and a sensible amount)')
  if (body?.note !== undefined && body?.note !== null && body?.note !== '' && note === null) return fail(400, 'invalid_request', 'Note must be text up to 200 characters')
  return { ok: true, data: { recipientEmail, gbAmount: Math.round(gb * 1000) / 1000, note } }
}

export async function allocateBandwidth(
  admin: Admin, reseller: Reseller, input: { recipientEmail: string; gbAmount: number; note: string | null }
): Promise<AllocResult<{ transfer_id: string | null; gb: number; recipient_email: string; message: string }>> {
  const { recipientEmail, gbAmount, note } = input

  // ── 1. Find recipient ───────────────────────────────────────────────────
  const { data: recipientProfile } = await admin
    .from('profiles').select('id, email, full_name, is_deleted, is_suspended').eq('email', recipientEmail).maybeSingle()

  // One answer for missing / deleted / suspended: three distinct messages would
  // let any reseller learn exactly which emails are registered and which of
  // those accounts are suspended.
  if (!recipientProfile || recipientProfile.is_deleted || recipientProfile.is_suspended) {
    return fail(404, 'not_found', 'No active GlobProxy account found for that email. They must sign up first, and their account must be in good standing.')
  }
  if (recipientProfile.id === reseller.id) return fail(400, 'invalid_request', 'Cannot allocate bandwidth to yourself.')

  // ── 2. Atomically check stock, move it, and write the history row ───────
  // allocate_reseller_bandwidth_tx (migration 0039) does all three in ONE
  // transaction. History used to be a separate, "non-fatal" insert, so a failed
  // write left bandwidth moved with no record of it.
  const { data: rpcResult, error: rpcError } = await admin.rpc('allocate_reseller_bandwidth_tx', {
    p_reseller_id: reseller.id, p_recipient_id: recipientProfile.id, p_gb: gbAmount, p_note: note,
  })
  if (rpcError) {
    const msg = rpcError.message ?? ''
    if (msg.includes('Not enough bandwidth')) return fail(400, 'insufficient_bandwidth', 'Not enough bandwidth in your stock.')
    if (msg.includes('yourself')) return fail(400, 'invalid_request', 'Cannot allocate bandwidth to yourself.')
    if (msg.includes('Minimum allocation') || msg.includes('decimal places') || msg.includes('too large')) return fail(400, 'invalid_request', msg)
    console.error('[reseller/allocate] RPC failed', rpcError)
    return fail(500, 'internal_error', 'Failed to complete transfer.')
  }
  const transferId: string | null = (Array.isArray(rpcResult) ? rpcResult[0]?.transfer_id : (rpcResult as any)?.transfer_id) ?? null

  // Webhooks. Awaited and never throw (see lib/webhooks.ts): the recipient is
  // told bandwidth landed; the reseller gets the matching "I allocated" event
  // so an automation can reconcile its own ledger.
  await dispatchWebhook(recipientProfile.id, 'bandwidth_credited', {
    gb_credited: gbAmount, source: 'reseller_allocation', transfer_id: transferId,
  })
  await dispatchWebhook(reseller.id, 'bandwidth_allocated', {
    transfer_id: transferId, recipient_email: recipientEmail, gb: gbAmount, note,
  })

  // ── 3. Notify both sides (best-effort; the transfer is already committed)
  const gbLabel = escapeHtml(formatGb(gbAmount))
  const senderName = escapeHtml(reseller.full_name?.split(' ')[0]) || 'there'
  const safeRecipient = escapeHtml(recipientEmail)
  const appUrl = getAppUrl()

  await Promise.allSettled([
    reseller.email
      ? sendEmail({
          to: reseller.email,
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
              ${escapeHtml(reseller.full_name) || escapeHtml(reseller.email) || 'your reseller'}.
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
  ]).then((results) => results.forEach((r) => { if (r.status === 'rejected') console.error('[reseller/allocate] email failed:', r.reason) }))

  return {
    ok: true,
    data: { transfer_id: transferId, gb: gbAmount, recipient_email: recipientEmail, message: `Successfully transferred ${formatGb(gbAmount)} to ${recipientEmail}` },
  }
}

// ── Reclaim ───────────────────────────────────────────────────────────
// Take back the UNUSED part of a transfer (typo'd email, cancelled order…).
// Only bandwidth the client has not used or committed to a credential, and has
// not since topped up past, can move back — and only within the reclaim window
// of the transfer. reclaim_reseller_allocation() enforces all of that under row
// locks.
export function parseReclaimBody(body: any): AllocResult<{ transferId: string; gb: number | null }> {
  const transferId = isUuid(body?.transfer_id) ? body.transfer_id : null
  if (!transferId) return fail(400, 'invalid_request', 'transfer_id is required')
  let gb: number | null = null
  if (body?.gb !== undefined && body?.gb !== null && body?.gb !== '') {
    gb = cleanNumber(body.gb)
    if (gb === null || gb <= 0 || Math.abs(gb * 1000 - Math.round(gb * 1000)) > 1e-6) {
      return fail(400, 'invalid_request', 'Enter a positive amount with at most 3 decimal places')
    }
  }
  return { ok: true, data: { transferId, gb } }
}

export async function reclaimAllocation(
  admin: Admin, reseller: Reseller, input: { transferId: string; gb: number | null }
): Promise<AllocResult<{ reclaimed_gb: number; remaining_gb: number }>> {
  const { data, error } = await admin.rpc('reclaim_reseller_allocation', {
    p_transfer_id: input.transferId, p_reseller_id: reseller.id, p_gb: input.gb,
  })
  if (error) {
    const msg = error.message ?? ''
    if (msg.includes('Nothing to reclaim') || msg.includes('Nothing left')) return fail(409, 'conflict', msg.replace(/^.*?: /, ''))
    if (msg.includes('not found')) return fail(404, 'not_found', 'Transfer not found')
    console.error('[reseller/reclaim] RPC failed', error)
    return fail(500, 'internal_error', 'Could not reclaim this transfer.')
  }
  const row = Array.isArray(data) ? data[0] : data
  const reclaimed = Number(row?.out_reclaimed_gb ?? 0)
  const remaining = Number(row?.out_remaining_gb ?? 0)

  // Tell the client their bandwidth was reduced — silent clawbacks are how
  // support tickets get created. Best-effort.
  const { data: transfer } = await admin
    .from('reseller_transfers').select('recipient_id, recipient:recipient_id(email, full_name)').eq('id', input.transferId).single()
  const recipient = transfer?.recipient as any
  if (recipient?.email && !String(recipient.email).startsWith('[')) {
    await sendEmail({
      to: recipient.email,
      subject: `${formatGb(reclaimed)} of unused bandwidth was returned to your reseller`,
      html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
            <h2 style="text-align:center;color:#111;">Unused bandwidth returned</h2>
            <p style="color:#444;text-align:center;">
              Hi ${escapeHtml(recipient.full_name?.split(' ')[0]) || 'there'}, <strong>${escapeHtml(formatGb(reclaimed))}</strong> of
              unused bandwidth that ${escapeHtml(reseller.full_name) || 'your reseller'} had transferred to you was returned to them.
              Bandwidth you've already used, assigned to a proxy, or bought yourself is never touched. Questions? Reply to this email or contact support@globproxy.com.
            </p>
          </div>`,
    }).catch((e) => console.error('[reseller/reclaim] notify failed', e))
  }
  // The client's side of the ledger shrank — an automation holding their
  // account should hear about it, not infer it.
  const recipientId = (transfer as any)?.recipient_id as string | undefined
  if (recipientId) await dispatchWebhook(recipientId, 'bandwidth_reclaimed', { transfer_id: input.transferId, gb_reclaimed: reclaimed, gb_remaining: remaining })

  return { ok: true, data: { reclaimed_gb: reclaimed, remaining_gb: remaining } }
}

// ── History ───────────────────────────────────────────────────────────
// Newest first; `before` (ISO timestamp, the previous page's last created_at)
// pages back. Read through the service role scoped to reseller_id (resellers
// have no RLS access to client profile rows — migration 0039).
export async function listTransfers(
  admin: Admin, resellerId: string, opts: { limit?: number; before?: string | null; beforeId?: string | null }
): Promise<AllocResult<{ transfers: any[]; has_more: boolean; next_before: string | null; next_before_id: string | null }>> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50) || 50, 1), 200)
  let q = admin
    .from('reseller_transfers')
    .select('id, gb_amount, reclaimed_gb, status, note, created_at, recipient:recipient_id(email)')
    .eq('reseller_id', resellerId)
    .order('created_at', { ascending: false }).order('id', { ascending: false })
    .limit(limit)
  const cur = applyCursor(q, opts.before, opts.beforeId, 'uuid')
  if (!cur.ok) return fail(400, 'invalid_request', cur.message)
  q = cur.query
  const { data, error } = await q
  if (error) { console.error('[reseller/transfers] list failed', error); return fail(500, 'internal_error', 'Could not load transfers.') }
  const transfers = (data ?? []).map((r: any) => ({
    id: r.id, recipient_email: r.recipient?.email ?? null,
    gb_amount: Number(r.gb_amount), gb_reclaimed: Number(r.reclaimed_gb ?? 0), gb_net: Number(r.gb_amount) - Number(r.reclaimed_gb ?? 0),
    status: r.status, note: r.note ?? null, created_at: r.created_at,
  }))
  const hasMore = transfers.length === limit
  return { ok: true, data: { transfers, has_more: hasMore, next_before: hasMore ? transfers[transfers.length - 1].created_at : null, next_before_id: hasMore ? transfers[transfers.length - 1].id : null } }
}
