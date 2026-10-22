import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, isUuid, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { sendEmailSafe, escapeHtml } from '@/lib/email'
import { adminNoticeHtml, appUrl } from '@/lib/adminEmail'
import { dispatchWebhook } from '@/lib/webhooks'

const MAX_ADJUST_GB = 100_000

// POST { userId, gb, reason } — gb > 0 credits, gb < 0 debits.
// For goodwill credits, dispute settlements and corrections. The balance
// change and its permanent record (bandwidth_adjustments) happen in ONE
// database transaction (admin_adjust_bandwidth), and a debit can never take
// GB that is already allocated to a session. The customer is told, without
// the internal reason.
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ userId?: unknown; gb?: unknown; reason?: unknown }>(req)
  if (!body || !isUuid(body.userId)) return badRequest('User ID missing or invalid')
  if (typeof body.gb !== 'number' || !Number.isFinite(body.gb) || body.gb === 0) return badRequest('gb must be a non-zero number')
  const gb = Math.round(body.gb * 1000) / 1000
  if (gb === 0 || Math.abs(gb) > MAX_ADJUST_GB) return badRequest(`gb must be between 0.001 and ${MAX_ADJUST_GB} (positive to credit, negative to debit)`)
  if (typeof body.reason !== 'string' || body.reason.trim().length < 3) return badRequest('A reason (at least 3 characters) is required')
  const reason = body.reason.trim().slice(0, 300)

  const { data: target } = await supabase.from('profiles').select('email, full_name, is_deleted').eq('id', body.userId).single()
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (target.is_deleted) return NextResponse.json({ error: 'This account has been deleted' }, { status: 409 })

  const { data: result, error } = await supabase.rpc('admin_adjust_bandwidth', {
    p_user_id: body.userId, p_admin_id: adminId, p_gb: gb, p_reason: reason,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const r = (result ?? {}) as { ok?: boolean; reason?: string; total_gb?: number; available_gb?: number }
  if (!r.ok) {
    const msg =
      r.reason === 'insufficient_available'
        ? `Only ${Number(r.available_gb ?? 0).toFixed(2)} GB is unallocated on this account — GB already allocated to sessions can't be taken back.`
        : r.reason === 'no_account' ? 'This user has no bandwidth account to debit.'
        : 'Could not adjust the balance.'
    return NextResponse.json({ error: msg }, { status: 409 })
  }

  await logAdminAction(supabase, {
    adminId, action: gb > 0 ? 'bandwidth.credit' : 'bandwidth.debit', targetUserId: body.userId,
    details: { gb, reason, total_gb_after: r.total_gb, available_gb_after: r.available_gb },
  })

  // Integrations mirroring the balance hear about it too. The internal reason is
  // never included.
  if (gb > 0) {
    await dispatchWebhook(body.userId, 'bandwidth_credited', { gb_credited: gb, source: 'admin_adjustment' })
  } else {
    await dispatchWebhook(body.userId, 'bandwidth_debited', {
      gb_debited: Math.abs(gb), source: 'admin_adjustment', total_gb: r.total_gb ?? null, available_gb: r.available_gb ?? null,
    })
  }

  if (target.email && target.email !== '[deleted]') {
    const name = escapeHtml(target.full_name?.split(' ')[0]) || 'there'
    await sendEmailSafe({
      to: target.email,
      subject: gb > 0 ? 'Bandwidth was added to your GlobProxy account' : 'Your GlobProxy bandwidth balance was adjusted',
      html: adminNoticeHtml({
        heading: gb > 0 ? 'Bandwidth added ✓' : 'Balance adjusted',
        bodyHtml: gb > 0
          ? `Hi ${name}, our team added <strong>${gb.toFixed(2)} GB</strong> to your account. It's available to use right away.`
          : `Hi ${name}, our team removed <strong>${Math.abs(gb).toFixed(2)} GB</strong> of unallocated bandwidth from your account. If you weren't expecting this, please contact support.`,
        cta: gb > 0 ? { href: `${appUrl()}/dashboard`, label: 'Open your dashboard →' } : { href: 'mailto:support@globproxy.com', label: 'Contact support →' },
      }),
    })
  }

  return NextResponse.json({ success: true, total_gb: r.total_gb, available_gb: r.available_gb })
}
