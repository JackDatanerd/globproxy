import { authorizeAdmin, readJson, badRequest, isUuid } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { NextResponse } from 'next/server'

// Edit the commission rates of an affiliate who's already approved.
// Previously the only post-approval lever was the Verified Operator
// toggle. Rates apply to commissions recorded FROM NOW ON; commissions
// already recorded keep the rate they were created at.
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ userId?: string; introRate?: unknown; lifetimeRate?: unknown }>(req)
  if (!body || !isUuid(body.userId)) return badRequest('User ID missing or invalid')
  const { introRate, lifetimeRate } = body
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1
  if (!ok(introRate) || !ok(lifetimeRate)) return badRequest('Commission rates must be numbers between 0 and 1')

  const { data: existing } = await supabase
    .from('profiles')
    .select('affiliate_status, is_verified_operator, is_deleted, affiliate_commission_rate, affiliate_commission_rate_lifetime')
    .eq('id', body.userId)
    .single()
  if (!existing || existing.is_deleted) return NextResponse.json({ error: 'Affiliate not found' }, { status: 404 })
  if (existing.affiliate_status !== 'approved' && existing.affiliate_status !== 'suspended') {
    return NextResponse.json({ error: 'Only an approved or suspended affiliate has rates to edit.' }, { status: 409 })
  }
  if (existing.is_verified_operator) {
    // The Verified Operator rate is fixed on purpose; changing it here
    // would silently desync it from the badge and from the saved
    // "restore on revoke" rates. Revoke Verified Operator first.
    return NextResponse.json({ error: 'This affiliate is a Verified Operator — revoke that first to set custom rates.' }, { status: 409 })
  }

  const { error } = await supabase
    .from('profiles')
    .update({ affiliate_commission_rate: introRate, affiliate_commission_rate_lifetime: lifetimeRate })
    .eq('id', body.userId)
    .eq('is_verified_operator', false)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await logAdminAction(supabase, {
    adminId, action: 'affiliate.set_rates', targetUserId: body.userId,
    details: { from: [existing.affiliate_commission_rate, existing.affiliate_commission_rate_lifetime], to: [introRate, lifetimeRate] },
  })
  return NextResponse.json({ success: true })
}
