import { anyLeaksSupplier, SUPPLIER_TEXT_ERROR } from '@/lib/supplierGuard'
import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, isUuid, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { adminNoticeHtml, appUrl } from '@/lib/adminEmail'
import { sendEmailSafe, escapeHtml } from '@/lib/email'
import { formatCycleLabel } from '@/lib/payoutCycle'

// POST { payoutId, reason } — the correction for a payout that was marked PAID
// but whose money never arrived (wrong address, failed transfer, wire returned).
// Marking paid was one-way: the only fix was SQL. This moves the payout back to
// Pending — with its commissions — so it can be re-sent (Mark paid again) or
// voided, and tells the affiliate it was not completed.
//
// Refused when a commission inside the payout was voided/recovered after it was
// paid: reversing would count that recovery twice. Resolve those first.
export async function POST(req: Request) {
  try {
    const auth = await authorizeAdmin(req)
    if (!auth.ok) return auth.response
    const { supabase, adminId } = auth

    const body = await readJson<{ payoutId?: unknown; reason?: unknown }>(req)
    if (!body || !isUuid(body.payoutId)) return badRequest('Payout ID missing or invalid')
    if (typeof body.reason !== 'string' || body.reason.trim().length < 3) return badRequest('A reason (at least 3 characters) is required')
    const reason = body.reason.trim().slice(0, 300)
    if (anyLeaksSupplier(reason)) return badRequest(SUPPLIER_TEXT_ERROR)

    const { data, error } = await supabase.rpc('admin_reverse_paid_payout', { p_payout_id: body.payoutId })
    if (error) {
      console.error('[admin/reverse-payout] rpc failed', error)
      return NextResponse.json({ error: 'Could not reverse this payout.' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Only a payout that is marked paid can be reversed.' }, { status: 409 })
    const d = data as any
    if (d.blocked === 'voided_commissions') {
      return NextResponse.json({ error: 'A commission in this payout was voided or recovered after it was paid. Resolve that first (Deductions), or contact engineering — reversing now would count it twice.' }, { status: 409 })
    }

    if (d.blocked === 'refund_deductions') {
      return NextResponse.json({ error: 'An order behind this payout was refunded after it was paid, so a deduction is waiting against the affiliate. Reversing now would pay the full amount and deduct it again. Waive the deduction first (Deductions), or void and re-run instead.' }, { status: 409 })
    }

    await logAdminAction(supabase, {
      adminId, action: 'payout.reversed', targetUserId: d.referrer_id ?? null, targetRef: body.payoutId,
      details: { reason, amount_usd: Number(d.amount_usd), cycle_start: d.cycle_start, cycle_end: d.cycle_end, was_reference: d.payment_reference ?? undefined, commissions_reverted: d.commissions_reverted },
    })

    if (d.referrer_id) {
      const { data: ref } = await supabase.from('profiles').select('email, full_name, is_deleted').eq('id', d.referrer_id).maybeSingle()
      if (ref?.email && ref.email !== '[deleted]' && !ref.is_deleted) {
        await sendEmailSafe({
          to: ref.email,
          subject: 'Your GlobProxy affiliate payout was not completed',
          html: adminNoticeHtml({
            heading: 'Payout not completed',
            bodyHtml: `Hi ${escapeHtml(ref.full_name?.split(' ')[0]) || 'there'}, the payout of <strong>$${Number(d.amount_usd).toFixed(2)}</strong> for ${escapeHtml(formatCycleLabel({ cycle_start: d.cycle_start, cycle_end: d.cycle_end }))} that we marked as sent did not go through: ${escapeHtml(reason)}. It is back in your pending payouts and we will send it again — please check that your payout details are correct.`,
            cta: { href: `${appUrl()}/dashboard/referrals`, label: 'Check my payout details →' },
          }),
        })
      }
    }
    return NextResponse.json({ success: true, commissions_reverted: d.commissions_reverted })
  } catch (err) {
    console.error('[admin/reverse-payout] unexpected error', err)
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}
