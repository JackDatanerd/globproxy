import { authorizeAdmin, readJson, badRequest, isUuid } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { adminNoticeHtml } from '@/lib/adminEmail'
import { sendEmailSafe, escapeHtml } from '@/lib/email'
import { NextResponse } from 'next/server'

// Suspend / reinstate an APPROVED affiliate. 'suspended' has always been a
// legal affiliate_status value, but nothing could ever set it, so an abusive
// affiliate could only be dealt with by suspending their whole account.
// While suspended: record_affiliate_commission() stops crediting (it only
// pays 'approved' affiliates) and run_affiliate_payout_cycle() reports them
// 'ineligible' — already-earned pending commissions stay put and are paid
// if the affiliate is reinstated. Verified Operator status is untouched.
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ userId?: string; action?: string; reason?: string }>(req)
  if (!body || !isUuid(body.userId)) return badRequest('User ID missing or invalid')
  if (body.action !== 'suspend' && body.action !== 'reinstate') return badRequest("action must be 'suspend' or 'reinstate'")
  const suspending = body.action === 'suspend'
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 300) : ''

  const { data: updated, error } = await supabase
    .from('profiles')
    .update({ affiliate_status: suspending ? 'suspended' : 'approved' })
    .eq('id', body.userId)
    .eq('affiliate_status', suspending ? 'approved' : 'suspended')
    .eq('is_deleted', false)
    .select('email, full_name')
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!updated) {
    return NextResponse.json(
      { error: suspending ? 'Only an approved affiliate can be suspended.' : 'This affiliate is not suspended.' },
      { status: 409 }
    )
  }

  await logAdminAction(supabase, { adminId, action: suspending ? 'affiliate.suspend' : 'affiliate.reinstate', targetUserId: body.userId, details: { reason: reason || undefined } })

  if (updated.email && updated.email !== '[deleted]') {
    const name = escapeHtml(updated.full_name?.split(' ')[0]) || 'there'
    await sendEmailSafe({
      to: updated.email,
      subject: suspending ? 'Your GlobProxy affiliate account has been suspended' : 'Your GlobProxy affiliate account has been reinstated',
      html: adminNoticeHtml({
        heading: suspending ? 'Affiliate account suspended' : 'Affiliate account reinstated ✓',
        bodyHtml: suspending
          ? `Hi ${name}, your affiliate account has been suspended, so new referrals won't earn commission for now.${reason ? ` Reason: ${escapeHtml(reason)}.` : ''} Commissions you've already earned are kept. Contact support if you think this is a mistake.`
          : `Hi ${name}, your affiliate account has been reinstated and new referrals earn commission again.`,
        cta: { href: 'mailto:support@globproxy.com', label: 'Contact support →' },
      }),
    })
  }
  return NextResponse.json({ success: true })
}
