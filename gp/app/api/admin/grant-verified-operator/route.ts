import { authorizeAdmin, readJson, badRequest, isUuid } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { adminNoticeHtml, appUrl } from '@/lib/adminEmail'
import { sendEmailSafe, escapeHtml } from '@/lib/email'
import { NextResponse } from 'next/server'
import { formatRatePct } from '@/lib/referrals'

// Verified Operator is a status on top of an already-approved affiliate,
// not a replacement for the application flow. Rates are fixed (not
// admin-supplied) — they're the ceiling this product's margins were
// designed around, and a free-form rate here would reopen exactly what this
// route exists to prevent. For a custom rate on a normal affiliate use
// /api/admin/set-affiliate-rates instead.
const VERIFIED_OPERATOR_INTRO_RATE = 0.40
const VERIFIED_OPERATOR_LIFETIME_RATE = 0.20
const DEFAULT_INTRO_RATE = 0.30
const DEFAULT_LIFETIME_RATE = 0.15

export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ userId?: string; revoke?: boolean }>(req)
  if (!body || !isUuid(body.userId)) return badRequest('User ID missing or invalid')
  const userId = body.userId
  const revoke = body.revoke === true

  const { data: existing } = await supabase
    .from('profiles')
    .select('affiliate_status, is_verified_operator, is_deleted, is_suspended, affiliate_commission_rate, affiliate_commission_rate_lifetime, verified_operator_prev_rate, verified_operator_prev_rate_lifetime')
    .eq('id', userId)
    .single()
  if (!existing) return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
  if (existing.is_deleted) return NextResponse.json({ error: 'This account has been deleted' }, { status: 409 })

  if (revoke) {
    if (!existing.is_verified_operator) {
      return NextResponse.json({ error: 'This affiliate is not a Verified Operator.' }, { status: 409 })
    }
    // Restore what they had BEFORE the grant (a custom approval rate, say)
    // instead of hard-resetting everyone to the defaults.
    const restoreIntro = existing.verified_operator_prev_rate ?? DEFAULT_INTRO_RATE
    const restoreLifetime = existing.verified_operator_prev_rate_lifetime ?? DEFAULT_LIFETIME_RATE

    const { data: revoked, error: revokeErr } = await supabase
      .from('profiles')
      .update({
        is_verified_operator: false,
        verified_operator_since: null,
        affiliate_commission_rate: restoreIntro,
        affiliate_commission_rate_lifetime: restoreLifetime,
        verified_operator_prev_rate: null,
        verified_operator_prev_rate_lifetime: null,
      })
      .eq('id', userId)
      .eq('is_verified_operator', true) // atomic — a concurrent revoke can't double-apply
      .select('email, full_name')
      .maybeSingle()
    if (revokeErr) return NextResponse.json({ error: revokeErr.message }, { status: 500 })
    if (!revoked) return NextResponse.json({ error: 'This affiliate is not a Verified Operator.' }, { status: 409 })

    await logAdminAction(supabase, { adminId, action: 'verified_operator.revoke', targetUserId: userId, details: { restored_intro_rate: restoreIntro, restored_lifetime_rate: restoreLifetime } })

    if (revoked.email && revoked.email !== '[deleted]') {
      await sendEmailSafe({
        to: revoked.email,
        subject: 'Your GlobProxy Verified Operator status has ended',
        html: adminNoticeHtml({
          heading: 'Verified Operator status ended',
          bodyHtml: `Hi ${escapeHtml(revoked.full_name?.split(' ')[0]) || 'there'}, your Verified Operator status has ended. Your affiliate account stays active at ${Math.round(restoreIntro * 100)}% for your referrals' first 90 days, then ${Math.round(restoreLifetime * 100)}%. Commissions already earned are unaffected.`,
          cta: { href: 'mailto:support@globproxy.com', label: 'Contact support →' },
        }),
      })
    }
    return NextResponse.json({ success: true, revoked: true })
  }

  if (existing.affiliate_status !== 'approved') {
    return NextResponse.json({ error: 'Only an already-approved affiliate can become a Verified Operator.' }, { status: 409 })
  }
  if (existing.is_suspended) {
    return NextResponse.json({ error: 'This account is suspended.' }, { status: 409 })
  }
  if (existing.is_verified_operator) {
    return NextResponse.json({ error: 'This affiliate is already a Verified Operator.' }, { status: 409 })
  }

  const prevIntro = Number(existing.affiliate_commission_rate ?? DEFAULT_INTRO_RATE)
  const prevLifetime = Number(existing.affiliate_commission_rate_lifetime ?? DEFAULT_LIFETIME_RATE)
  // Never LOWER a rate: an affiliate already approved above the Verified
  // Operator rate keeps it.
  const newIntro = Math.max(prevIntro, VERIFIED_OPERATOR_INTRO_RATE)
  const newLifetime = Math.max(prevLifetime, VERIFIED_OPERATOR_LIFETIME_RATE)

  const { data: operator, error: updateErr } = await supabase
    .from('profiles')
    .update({
      is_verified_operator: true,
      verified_operator_since: new Date().toISOString(),
      affiliate_commission_rate: newIntro,
      affiliate_commission_rate_lifetime: newLifetime,
      verified_operator_prev_rate: prevIntro,
      verified_operator_prev_rate_lifetime: prevLifetime,
    })
    .eq('id', userId)
    .eq('is_verified_operator', false) // atomic
    .eq('affiliate_status', 'approved')
    .select('email, full_name')
    .maybeSingle()
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })
  if (!operator) return NextResponse.json({ error: 'This affiliate can no longer be upgraded (status changed).' }, { status: 409 })

  await logAdminAction(supabase, { adminId, action: 'verified_operator.grant', targetUserId: userId, details: { intro_rate: newIntro, lifetime_rate: newLifetime, prev_intro_rate: prevIntro, prev_lifetime_rate: prevLifetime } })

  if (operator.email && operator.email !== '[deleted]') {
    await sendEmailSafe({
      to: operator.email,
      subject: "You're a GlobProxy Verified Operator",
      html: adminNoticeHtml({
        heading: 'Verified Operator ✓',
        bodyHtml: `Hi ${escapeHtml(operator.full_name?.split(' ')[0]) || 'there'}, we've upgraded your affiliate account to Verified Operator. You'll now earn ${formatRatePct(newIntro)} on your referrals' orders for their first 90 days, then ${formatRatePct(newLifetime)} on all their later orders.`,
        cta: { href: `${appUrl()}/dashboard/referrals`, label: 'View your dashboard →' },
      }),
    })
  }

  return NextResponse.json({ success: true })
}
