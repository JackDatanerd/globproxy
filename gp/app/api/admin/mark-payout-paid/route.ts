import { authorizeAdmin, readJson, badRequest, isUuid } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { adminNoticeHtml, appUrl } from '@/lib/adminEmail'
import { sendEmailSafe, escapeHtml } from '@/lib/email'
import { formatCycleLabel } from '@/lib/payoutCycle'
import { NextResponse } from 'next/server'

// One action for a whole cycle's payout to one affiliate — not per
// commission. The actual money movement (USDT transfer, bank wire,
// M-Pesa) happens outside the app; this route records that it happened,
// WHO recorded it and the payment reference, and notifies the affiliate.
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ payoutId?: string; reference?: unknown }>(req)
  if (!body || !isUuid(body.payoutId)) return badRequest('Payout ID missing or invalid')
  if (body.reference != null && typeof body.reference !== 'string') return badRequest('reference must be text')
  const reference = (body.reference ?? '').toString().trim().slice(0, 200)

  // mark_affiliate_payout_paid is the idempotent, atomic claim (updates the
  // payout row AND mirrors status onto its still-pending linked commissions
  // in one transaction) — migration 0043. false = already paid, surfaced as
  // 409 so a double-click doesn't look like it did something twice.
  const { data: claimed, error: rpcErr } = await supabase.rpc('mark_affiliate_payout_paid', {
    p_payout_id: body.payoutId,
    p_paid_by: adminId,
    p_reference: reference || null,
  })
  if (rpcErr) return NextResponse.json({ error: rpcErr.message }, { status: 500 })
  if (!claimed) return NextResponse.json({ error: 'This payout is not in a payable state (already paid?)' }, { status: 409 })

  const { data: payout } = await supabase
    .from('affiliate_payouts')
    .select('referrer_id, amount_usd, cycle_start, cycle_end, payout_method, referrer:referrer_id(email, full_name)')
    .eq('id', body.payoutId)
    .single()

  await logAdminAction(supabase, {
    adminId, action: 'payout.mark_paid', targetUserId: payout?.referrer_id ?? null, targetRef: body.payoutId,
    details: { amount_usd: payout ? Number(payout.amount_usd) : undefined, method: payout?.payout_method, reference: reference || undefined },
  })

  const referrer = payout?.referrer as any
  if (referrer?.email && referrer.email !== '[deleted]' && payout) {
    const methodLabel = payout.payout_method === 'usdt' ? 'USDT (TRC20)' : payout.payout_method === 'mpesa' ? 'M-Pesa' : 'bank transfer'
    const delivered = await sendEmailSafe({
      to: referrer.email,
      subject: 'Your GlobProxy affiliate payout has been sent',
      html: adminNoticeHtml({
        heading: 'Payout sent ✓',
        bodyHtml: `Hi ${escapeHtml(referrer.full_name?.split(' ')[0]) || 'there'}, your affiliate payout of <strong>$${Number(payout.amount_usd).toFixed(2)}</strong> for ${escapeHtml(formatCycleLabel(payout))} has been sent via ${methodLabel}.${reference ? `<br/><span style="font-size:12px;color:#888;">Reference: ${escapeHtml(reference)}</span>` : ''}`,
        cta: { href: `${appUrl()}/dashboard/referrals`, label: 'View your payout history →' },
      }),
    })
    // notified_at used to be stamped before (and regardless of) the send.
    if (delivered) {
      await supabase.from('affiliate_payouts').update({ notified_at: new Date().toISOString() }).eq('id', body.payoutId)
    }
  }

  return NextResponse.json({ success: true })
}
