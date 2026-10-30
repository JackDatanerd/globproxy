import { applyCursor, cursorTs } from '@/lib/cursor'
import { createAdminClient } from '@/lib/supabase/server'
import { sendEmail, sendEmailSafe, escapeHtml } from '@/lib/email'
import { dispatchWebhook } from '@/lib/webhooks'
import { cleanText, cleanNumber } from '@/lib/validation'
import { isUuid } from '@/lib/adminAuth'
import { formatGb } from '@/lib/format'
import { appUrl as getAppUrl } from '@/lib/appUrl'
import { adminNoticeHtml } from '@/lib/adminEmail'
import { INVITE_REMINDER_MAX } from '@/lib/reseller'

// The single implementation of reseller → client bandwidth allocation and
// reclaim. Shared by the dashboard routes (/api/reseller/allocate, /reclaim —
// session auth + 2FA) and the public API (/api/v1/reseller/*, `allocate`-scope
// keys), so the stock check, the atomic transfer, the notifications and the
// webhooks can never drift apart between the two entry points. Authentication,
// 2FA, throttling and request parsing stay with the caller; everything from
// "validated input" onward lives here.
type Admin = Awaited<ReturnType<typeof createAdminClient>>

export const MIN_ALLOCATION_GB = 0.1
// One address, no whitespace or second @, a dotted domain. Keep in step with create_pending_reseller_transfer (migration 0110).
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
// Keep in step with the 50-per-24h check inside create_pending_reseller_transfer (migration 0070).
const NEW_RECIPIENTS_PER_DAY = 50
const NEW_RECIPIENTS_MESSAGE = 'You have reached today\'s limit of 50 new recipients. Existing clients are not affected — try again tomorrow.'

export type AllocFail = { ok: false; status: number; code: 'invalid_request' | 'not_found' | 'conflict' | 'insufficient_bandwidth' | 'rate_limited' | 'internal_error'; message: string
  /** True when the database call may have COMMITTED before the failure reached us (a dropped connection, a
   *  timeout). The caller must not free an Idempotency-Key for it: a retry could move the stock twice. */
  outcomeUnknown?: boolean
  /** Seconds until a 429 may be retried; the API route sends it as Retry-After. */
  retryAfterSeconds?: number }
export type AllocResult<T> = { ok: true; data: T } | AllocFail
const fail = (status: number, code: AllocFail['code'], message: string): AllocFail => ({ ok: false, status, code, message })

// A Postgres error carries a SQLSTATE and means the statement rolled back. postgrest-js reports a
// transport failure (fetch failed, timeout, reset connection) as an error with NO code, and then
// the transaction may or may not have committed on the database side.
export function isAmbiguousDbError(error: { code?: string | null } | null | undefined): boolean {
  return !!error && !error.code
}
// The generic "something unexpected failed" answer for a money-moving RPC.
const failUnexpected = (error: { code?: string | null; message?: string | null }, message: string): AllocFail =>
  ({ ...fail(500, 'internal_error', message), ...(isAmbiguousDbError(error) ? { outcomeUnknown: true } : {}) })

export type Reseller = { id: string; email?: string | null; full_name?: string | null }

// ── Allocate ──────────────────────────────────────────────────────────
export function parseAllocationBody(body: any): AllocResult<{ recipientEmail: string; gbAmount: number; note: string | null }> {
  // The old check was `!gb_allocated || gb_allocated <= 0`, which let strings
  // and NaN through to the database cast and threw on non-string emails.
  const recipientEmail = cleanText(body?.recipient_email, 254)?.toLowerCase() ?? null
  const gb = cleanNumber(body?.gb_allocated)
  const note = body?.note === undefined || body?.note === null || body?.note === '' ? null : cleanText(body.note, 200)

  if (!recipientEmail || !EMAIL_SHAPE.test(recipientEmail)) return fail(400, 'invalid_request', 'A valid recipient email is required')
  if (gb === null || gb < MIN_ALLOCATION_GB) return fail(400, 'invalid_request', `Enter an amount of at least ${MIN_ALLOCATION_GB} GB`)
  if (gb > 1_000_000 || Math.abs(gb * 1000 - Math.round(gb * 1000)) > 1e-6) return fail(400, 'invalid_request', 'Use at most 3 decimal places (and a sensible amount)')
  if (body?.note !== undefined && body?.note !== null && body?.note !== '' && note === null) return fail(400, 'invalid_request', 'Note must be text up to 200 characters')
  return { ok: true, data: { recipientEmail, gbAmount: Math.round(gb * 1000) / 1000, note } }
}

export type AllocateData = {
  transfer_id: string | null
  /** 'active' = landed on a registered account; 'pending_signup' = invitation sent, stock reserved. */
  status: 'active' | 'pending_signup'
  pending_id: string | null
  expires_at: string | null
  gb: number
  recipient_email: string
  message: string
}

export async function allocateBandwidth(
  admin: Admin, reseller: Reseller, input: { recipientEmail: string; gbAmount: number; note: string | null }
): Promise<AllocResult<AllocateData>> {
  const { recipientEmail, gbAmount, note } = input

  // ── 1. Find recipient ───────────────────────────────────────────────────
  const { data: recipientProfile } = await admin
    .from('profiles').select('id, email, full_name, is_deleted, is_suspended').eq('email', recipientEmail).maybeSingle()

  // No account / closed / suspended all take the SAME path: the stock is
  // reserved and an invitation is held for that address. The three cases used
  // to give three distinct answers, which let a reseller learn which emails
  // are registered and which accounts are suspended; now only "this address is
  // an active account right now" differs, and a suspended or closed account's
  // invitation simply never completes.
  // An account that exists but has never confirmed its address is not credited
  // either: whoever typed the address first may not own it, and the GB would
  // follow the account, not the owner. It takes the invitation path, which
  // completes the moment the address is confirmed.
  let unconfirmed = false
  if (recipientProfile && !recipientProfile.is_deleted && !recipientProfile.is_suspended) {
    const { data: unconfirmedId } = await admin.rpc('auth_unconfirmed_user_id', { check_email: recipientEmail })
    unconfirmed = !!unconfirmedId
  }
  if (!recipientProfile || recipientProfile.is_deleted || recipientProfile.is_suspended || unconfirmed) {
    return inviteRecipient(admin, reseller, input, !recipientProfile || unconfirmed)
  }
  if (recipientProfile.id === reseller.id) return fail(400, 'invalid_request', 'Cannot allocate bandwidth to yourself.')

  // A NEW client (never sent to before) draws on a daily budget, so the allocate
  // endpoint cannot be used to probe or e-mail a long list of addresses.
  const { count: prior } = await admin.from('reseller_transfers').select('id', { count: 'exact', head: true })
    .eq('reseller_id', reseller.id).eq('recipient_id', recipientProfile.id)
  if (!prior) {
    const { data: newToday } = await admin.rpc('reseller_new_recipients_24h', { p_reseller_id: reseller.id })
    if (Number(newToday ?? 0) >= NEW_RECIPIENTS_PER_DAY) return fail(429, 'rate_limited', NEW_RECIPIENTS_MESSAGE)
  }

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
    if (msg.includes('Too many new recipients')) return fail(429, 'rate_limited', NEW_RECIPIENTS_MESSAGE)
    if (msg.includes('Minimum allocation') || msg.includes('decimal places') || msg.includes('too large')) return fail(400, 'invalid_request', msg)
    console.error('[reseller/allocate] RPC failed', rpcError)
    return failUnexpected(rpcError, 'Failed to complete transfer.')
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
              © ${new Date().getFullYear()} GlobProxy · Residential Proxies That Never Expire
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
              © ${new Date().getFullYear()} GlobProxy · Residential Proxies That Never Expire
            </p>
          </div>
        `,
        })
      : Promise.resolve(),
  ]).then((results) => results.forEach((r) => { if (r.status === 'rejected') console.error('[reseller/allocate] email failed:', r.reason) }))

  return {
    ok: true,
    data: {
      transfer_id: transferId, status: 'active', pending_id: null, expires_at: null,
      gb: gbAmount, recipient_email: recipientEmail, message: `Successfully transferred ${formatGb(gbAmount)} to ${recipientEmail}`,
    },
  }
}

// ── Invite-and-claim ──────────────────────────────────────────────────
// Allocating to an address with no usable account reserves the stock now
// (create_pending_reseller_transfer — migration 0066) and e-mails an
// invitation. The GB lands the moment that address is a CONFIRMED account: the
// database claims it on confirmation, and sendInviteResolutionNotices() tells
// both sides. Unclaimed invitations expire after 30 days and the stock returns.
async function inviteRecipient(
  admin: Admin, reseller: Reseller, input: { recipientEmail: string; gbAmount: number; note: string | null }, canInvite: boolean
): Promise<AllocResult<AllocateData>> {
  const { recipientEmail, gbAmount, note } = input
  const { data, error } = await admin.rpc('create_pending_reseller_transfer', {
    p_reseller_id: reseller.id, p_email: recipientEmail, p_gb: gbAmount, p_note: note,
  })
  if (error) {
    const msg = error.message ?? ''
    if (msg.includes('Not enough bandwidth')) return fail(400, 'insufficient_bandwidth', 'Not enough bandwidth in your stock.')
    if (msg.includes('yourself')) return fail(400, 'invalid_request', 'Cannot allocate bandwidth to yourself.')
    if (msg.includes('Too many new recipients')) return fail(429, 'rate_limited', NEW_RECIPIENTS_MESSAGE)
    if (msg.includes('Too many open invitations')) return fail(409, 'conflict', 'You have too many open invitations. Cancel some, or wait for them to be claimed.')
    if (msg.includes('Minimum allocation') || msg.includes('decimal places') || msg.includes('too large') || msg.includes('valid recipient')) return fail(400, 'invalid_request', msg)
    console.error('[reseller/allocate] invite RPC failed', error)
    return failUnexpected(error, 'Failed to complete transfer.')
  }
  const row = Array.isArray(data) ? data[0] : data
  const pendingId: string | null = row?.out_pending_id ?? null
  const totalGb = Number(row?.out_total_gb ?? gbAmount)
  const expiresAt: string | null = row?.out_expires_at ?? null
  const firstInvite = Math.abs(totalGb - gbAmount) < 1e-9 // false when it was added to an invitation already open
  await dispatchWebhook(reseller.id, 'reseller_invitation_created', {
    pending_id: pendingId, recipient_email: recipientEmail, gb: gbAmount, total_gb: totalGb, expires_at: expiresAt, topped_up: !firstInvite,
  })
  const appUrl = getAppUrl()
  const resellerLabel = escapeHtml(reseller.full_name) || escapeHtml(reseller.email) || 'A GlobProxy reseller'

  await Promise.allSettled([
    // The invitation itself — only the first time, so topping an open invitation
    // up never re-mails the invitee.
    canInvite && firstInvite
      ? sendEmail({
          to: recipientEmail,
          subject: `${reseller.full_name || 'A GlobProxy reseller'} has set aside bandwidth for you`,
          html: adminNoticeHtml({
            heading: 'Bandwidth is waiting for you',
            bodyHtml: `${resellerLabel} has reserved <strong>${escapeHtml(formatGb(gbAmount))}</strong> of residential proxy bandwidth on GlobProxy for this email address.
              Create an account with <strong>${escapeHtml(recipientEmail)}</strong> and confirm it — the bandwidth is added automatically. The offer expires in 30 days.`,
            cta: { href: `${appUrl}/auth/signup?email=${encodeURIComponent(recipientEmail)}&invited=1`, label: 'Create your account →' },
          }),
        })
      : Promise.resolve(),
    reseller.email
      ? sendEmail({
          to: reseller.email,
          subject: `Reserved: ${formatGb(gbAmount)} for ${recipientEmail}`,
          html: adminNoticeHtml({
            heading: 'Invitation sent ✓',
            bodyHtml: `Hi ${escapeHtml(reseller.full_name?.split(' ')[0]) || 'there'}, <strong>${escapeHtml(formatGb(gbAmount))}</strong> is reserved for ${escapeHtml(recipientEmail)} and
              has been taken out of your available stock. It is added to their account when they sign up with that address and confirm it. If they haven't within 30 days,
              it returns to your stock — you can also cancel it any time from your transfer history.`,
            cta: { href: `${appUrl}/reseller/transfers`, label: 'View transfer history →' },
          }),
        })
      : Promise.resolve(),
  ]).then((results) => results.forEach((r) => { if (r.status === 'rejected') console.error('[reseller/allocate] invite email failed:', r.reason) }))

  return {
    ok: true,
    data: {
      transfer_id: null, status: 'pending_signup', pending_id: pendingId, expires_at: expiresAt,
      gb: gbAmount, recipient_email: recipientEmail,
      message: `${formatGb(gbAmount)} reserved for ${recipientEmail}. They'll receive it when they sign up with that address and confirm it.`,
    },
  }
}

export async function cancelInvitation(
  admin: Admin, reseller: Reseller, pendingId: string, source: 'dashboard' | 'api' | 'support' = 'dashboard'
): Promise<AllocResult<{ returned_gb: number }>> {
  if (!isUuid(pendingId)) return fail(400, 'invalid_request', 'pending_id is required')
  const { data: before } = await admin.from('reseller_pending_transfers')
    .select('recipient_email').eq('id', pendingId).eq('reseller_id', reseller.id).maybeSingle()
  const { data, error } = await admin.rpc('cancel_pending_reseller_transfer', { p_id: pendingId, p_reseller_id: reseller.id })
  if (error) { console.error('[reseller/cancel-invite] RPC failed', error); return fail(500, 'internal_error', 'Could not cancel this invitation.') }
  if (data === null || data === undefined) return fail(404, 'not_found', 'Invitation not found, or it has already been claimed or cancelled.')
  await dispatchWebhook(reseller.id, 'reseller_invitation_cancelled', {
    pending_id: pendingId, recipient_email: before?.recipient_email ?? null, gb: Number(data), source,
  })
  return { ok: true, data: { returned_gb: Number(data) } }
}

// Lower the amount reserved on an open invitation (a typo'd figure) without cancelling it:
// the difference goes straight back to the reseller's stock, the expiry and the reminder
// count are untouched, and the 50-new-recipients budget is not spent again. To remove an
// invitation altogether use cancelInvitation.
export async function reduceInvitation(
  admin: Admin, reseller: Reseller, pendingId: string, gb: unknown
): Promise<AllocResult<{ gb: number; returned_gb: number }>> {
  if (!isUuid(pendingId)) return fail(400, 'invalid_request', 'pending_id is required')
  const n = cleanNumber(gb)
  if (n === null || n < MIN_ALLOCATION_GB || n > 1_000_000 || Math.abs(n * 1000 - Math.round(n * 1000)) > 1e-6) {
    return fail(400, 'invalid_request', `Enter the new amount: at least ${MIN_ALLOCATION_GB} GB, at most 3 decimal places`)
  }
  const newGb = Math.round(n * 1000) / 1000
  const { data, error } = await admin.rpc('reduce_pending_reseller_transfer', { p_id: pendingId, p_reseller_id: reseller.id, p_gb: newGb })
  if (error) {
    const msg = error.message ?? ''
    if (msg.includes('Minimum allocation') || msg.includes('decimal places')) return fail(400, 'invalid_request', msg)
    console.error('[reseller/reduce-invite] RPC failed', error)
    return fail(500, 'internal_error', 'Could not change this invitation.')
  }
  const row: any = Array.isArray(data) ? data[0] : data
  if (!row || row.out_result === 'not_found') return fail(404, 'not_found', 'Invitation not found, or it has already been claimed, cancelled or expired.')
  if (row.out_result === 'not_lower') return fail(400, 'invalid_request', `The invitation is for ${formatGb(Number(row.out_gb))} GB — enter a smaller amount, or send more to top it up.`)
  return { ok: true, data: { gb: Number(row.out_gb), returned_gb: Number(row.out_returned_gb) } }
}

// Re-send the invitation e-mail for an invitation nobody has claimed yet. The
// database decides whether a reminder may go out (remind_pending_reseller_transfer:
// 24 h after the invitation or the last reminder, at most INVITE_REMINDER_MAX in
// total) and stamps it under a row lock, so a double click or a click plus an API
// call can never send two. Only an address with NO usable account is mailed — the
// same rule as the first invitation, so this can't be used to e-mail the owner of
// an existing account.
export async function remindInvitation(
  admin: Admin, reseller: Reseller, pendingId: string
): Promise<AllocResult<{ reminders_left: number; expires_at: string | null }>> {
  if (!isUuid(pendingId)) return fail(400, 'invalid_request', 'pending_id is required')
  const { data: pending } = await admin.from('reseller_pending_transfers')
    .select('recipient_email').eq('id', pendingId).eq('reseller_id', reseller.id).eq('status', 'pending').maybeSingle()
  if (!pending) return fail(404, 'not_found', 'Invitation not found, or it has already been claimed, cancelled or expired.')

  const { data: profile } = await admin.from('profiles').select('id, is_deleted, is_suspended').eq('email', pending.recipient_email).maybeSingle()
  let mailable = !profile
  if (profile && !profile.is_deleted && !profile.is_suspended) {
    const { data: unconfirmedId } = await admin.rpc('auth_unconfirmed_user_id', { check_email: pending.recipient_email })
    mailable = !!unconfirmedId
  }
  if (!mailable) return fail(409, 'conflict', 'This address already has an account, so there is nobody to remind — the bandwidth is delivered as soon as the invitation is processed.')

  const { data, error } = await admin.rpc('remind_pending_reseller_transfer', { p_id: pendingId, p_reseller_id: reseller.id })
  if (error) { console.error('[reseller/remind] RPC failed', error); return fail(500, 'internal_error', 'Could not send the reminder.') }
  const row: any = Array.isArray(data) ? data[0] : data
  if (!row || row.out_result === 'not_found') return fail(404, 'not_found', 'Invitation not found, or it has already been claimed, cancelled or expired.')
  if (row.out_result === 'limit') return fail(409, 'conflict', `This invitation has already been re-sent ${INVITE_REMINDER_MAX} times. Cancel it and send a new one if they still haven't seen it.`)
  if (row.out_result === 'cooldown') {
    const when = row.out_retry_at ? new Date(row.out_retry_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC' : 'later'
    const secs = row.out_retry_at ? Math.ceil((new Date(row.out_retry_at).getTime() - Date.now()) / 1000) : 0
    return { ...fail(429, 'rate_limited', `A reminder can be sent once every 24 hours. Try again after ${when}.`), ...(secs > 0 ? { retryAfterSeconds: Math.min(secs, 86_400) } : {}) }
  }

  const gb = Number(row.out_gb)
  const daysLeft = Math.max(1, Math.ceil((new Date(row.out_expires_at).getTime() - Date.now()) / 86_400_000))
  const resellerLabel = escapeHtml(reseller.full_name) || escapeHtml(reseller.email) || 'A GlobProxy reseller'
  // sendEmail never throws on a provider rejection (it logs and returns the response),
  // so use the variant that says whether the message really went out. When it did
  // not, the reminder slot is handed back and the reseller is told the truth.
  let delivered = false
  try {
    delivered = await sendEmailSafe({
      to: row.out_email,
      subject: `Reminder: ${reseller.full_name || 'a GlobProxy reseller'} has bandwidth waiting for you`,
      html: adminNoticeHtml({
        heading: 'Your bandwidth is still waiting',
        bodyHtml: `${resellerLabel} reserved <strong>${escapeHtml(formatGb(gb))}</strong> of residential proxy bandwidth on GlobProxy for this email address.
          Create an account with <strong>${escapeHtml(row.out_email)}</strong> and confirm it — the bandwidth is added automatically. The offer expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`,
        cta: { href: `${getAppUrl()}/auth/signup?email=${encodeURIComponent(String(row.out_email))}&invited=1`, label: 'Create your account →' },
      }),
    })
  } catch (e) {
    console.error('[reseller/remind] reminder email threw', pendingId, e)
  }
  if (!delivered) {
    const { error: refundErr } = await admin.rpc('refund_pending_reseller_reminder', { p_id: pendingId, p_reseller_id: reseller.id, p_prev_at: row.out_prev_reminded_at ?? null })
    if (refundErr) console.error('[reseller/remind] could not hand the reminder slot back', pendingId, refundErr)
    return fail(502, 'internal_error', 'We could not send the reminder email just now, so it was not counted. Try again in a few minutes.')
  }
  const { data: after } = await admin.from('reseller_pending_transfers').select('reminder_count').eq('id', pendingId).maybeSingle()
  return { ok: true, data: { reminders_left: Math.max(0, INVITE_REMINDER_MAX - Number(after?.reminder_count ?? 0)), expires_at: row.out_expires_at ?? null } }
}

// Sweep: tell both sides about invitations the database resolved on its own
// (claimed at confirmation, or expired). Runs from the 5-minute cron; each row
// is claimed (notified_at stamped) BEFORE it is sent, so overlapping sweeps can
// never double-send; the cost is that a crash mid-send loses that one notice.
export async function sendInviteResolutionNotices(admin: Admin): Promise<{ claimed: number; expired: number }> {
  const out = { claimed: 0, expired: 0 }
  const { data: rows, error } = await admin
    .from('reseller_pending_transfers')
    .select('id, reseller_id, recipient_email, gb_amount, note, status, claimed_by, transfer_id')
    .in('status', ['claimed', 'expired']).is('notified_at', null)
    .order("resolved_at", { ascending: true }).limit(50)
  if (error) { console.error('[reseller/invites] sweep query failed', error); return out }

  for (const r of rows ?? []) {
    try {
      // Claim the row first so two overlapping sweeps can't both send.
      const { data: won } = await admin.from('reseller_pending_transfers')
        .update({ notified_at: new Date().toISOString() }).eq('id', r.id).is('notified_at', null).select('id')
      if (!won?.length) continue

      const { data: reseller } = await admin.from('profiles').select('email, full_name').eq('id', r.reseller_id).maybeSingle()
      const resellerOk = reseller?.email && !String(reseller.email).startsWith('[')
      // A deleted reseller's invitation rows were anonymised ('[removed]') by the account purge: there is no address to mail.
      const inviteeOk = !String(r.recipient_email).startsWith('[')
      const gbLabel = escapeHtml(formatGb(Number(r.gb_amount)))
      const appUrl = getAppUrl()

      if (r.status === 'claimed' && r.claimed_by) {
        out.claimed++
        await dispatchWebhook(r.claimed_by, 'bandwidth_credited', { gb_credited: Number(r.gb_amount), source: 'reseller_allocation', transfer_id: r.transfer_id })
        await dispatchWebhook(r.reseller_id, 'bandwidth_allocated', { transfer_id: r.transfer_id, recipient_email: r.recipient_email, gb: Number(r.gb_amount), note: r.note ?? null })
        await Promise.allSettled([
          resellerOk ? sendEmail({
            to: reseller!.email,
            subject: `Delivered: ${formatGb(Number(r.gb_amount))} to ${r.recipient_email}`,
            html: adminNoticeHtml({
              heading: 'Invitation accepted ✓',
              bodyHtml: `${escapeHtml(r.recipient_email)} created their account, and <strong>${gbLabel}</strong> is now active on it. You can reclaim any part they haven't used from your transfer history.`,
              cta: { href: `${appUrl}/reseller/transfers`, label: 'View transfer history →' },
            }),
          }) : Promise.resolve(),
          inviteeOk ? sendEmail({
            to: r.recipient_email,
            subject: `${formatGb(Number(r.gb_amount))} of bandwidth was added to your account`,
            html: adminNoticeHtml({
              heading: 'Bandwidth added ✓',
              bodyHtml: `<strong>${gbLabel}</strong> from ${escapeHtml(reseller?.full_name) || 'your reseller'} has been added to your GlobProxy account. It's ready to use now.`,
              cta: { href: `${appUrl}/dashboard`, label: 'Go to dashboard →' },
            }),
          }) : Promise.resolve(),
        ])
      } else if (r.status === 'expired') {
        out.expired++
        await dispatchWebhook(r.reseller_id, 'reseller_invitation_expired', { pending_id: r.id, recipient_email: r.recipient_email, gb: Number(r.gb_amount) })
        if (resellerOk) {
          await sendEmail({
            to: reseller!.email,
            subject: `Invitation expired: ${formatGb(Number(r.gb_amount))} returned to your stock`,
            html: adminNoticeHtml({
              heading: 'Invitation expired',
              bodyHtml: `${escapeHtml(r.recipient_email)} didn't sign up within 30 days, so the <strong>${gbLabel}</strong> reserved for them is back in your available stock.`,
              cta: { href: `${appUrl}/reseller`, label: 'Open your reseller dashboard →' },
            }),
          }).catch((e) => console.error('[reseller/invites] expiry email failed', e))
        }
      }
    } catch (e) {
      console.error('[reseller/invites] notice failed for', r.id, e)
    }
  }
  return out
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
    return failUnexpected(error, 'Could not reclaim this transfer.')
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
  // The reseller gets a record too: a reclaim made from the API or by a second
  // person with access to the account otherwise leaves nothing in their inbox.
  if (reseller.email && !String(reseller.email).startsWith('[')) {
    await sendEmail({
      to: reseller.email,
      subject: `Reclaimed: ${formatGb(reclaimed)} back in your stock`,
      html: adminNoticeHtml({
        heading: 'Bandwidth reclaimed ✓',
        bodyHtml: `<strong>${escapeHtml(formatGb(reclaimed))}</strong> was taken back from ${escapeHtml(recipient?.email && !String(recipient.email).startsWith('[') ? recipient.email : 'a client')} and is back in your available stock${remaining > 0 ? ` (${escapeHtml(formatGb(remaining))} of that transfer remains with them)` : ''}.`,
        cta: { href: `${getAppUrl()}/reseller/transfers`, label: 'View transfer history →' },
      }),
    }).catch((e) => console.error('[reseller/reclaim] reseller notice failed', e))
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
  admin: Admin, resellerId: string, opts: { limit?: number; before?: string | null; beforeId?: string | null; recipientId?: string | null }
): Promise<AllocResult<{ transfers: any[]; has_more: boolean; next_before: string | null; next_before_id: string | null }>> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50) || 50, 1), 200)
  let q = admin
    .from('reseller_transfers')
    .select('id, gb_amount, reclaimed_gb, status, note, created_at, recipient:recipient_id(email, is_deleted)')
    .eq('reseller_id', resellerId)
    .order('created_at', { ascending: false }).order('id', { ascending: false })
    .limit(limit + 1) // one extra row: tells us whether another page really exists
  if (opts.recipientId) {
    if (!isUuid(opts.recipientId)) return fail(400, 'invalid_request', 'client_id must be a valid id')
    q = q.eq('recipient_id', opts.recipientId)
  }
  const cur = applyCursor(q, opts.before, opts.beforeId, 'uuid')
  if (!cur.ok) return fail(400, 'invalid_request', cur.message)
  q = cur.query
  const { data, error } = await q
  if (error) { console.error('[reseller/transfers] list failed', error); return fail(500, 'internal_error', 'Could not load transfers.') }
  const fetched = data ?? []
  const hasMore = fetched.length > limit
  const transfers = fetched.slice(0, limit).map((r: any) => ({
    id: r.id, recipient_email: r.recipient?.is_deleted ? null : (r.recipient?.email ?? null),
    gb_amount: Number(r.gb_amount), gb_reclaimed: Number(r.reclaimed_gb ?? 0), gb_net: Math.round((Number(r.gb_amount) - Number(r.reclaimed_gb ?? 0)) * 1000) / 1000,
    status: r.status, note: r.note ?? null, created_at: r.created_at,
  }))
  return { ok: true, data: { transfers, has_more: hasMore, next_before: hasMore ? cursorTs(transfers[transfers.length - 1].created_at) : null, next_before_id: hasMore ? transfers[transfers.length - 1].id : null } }
}
