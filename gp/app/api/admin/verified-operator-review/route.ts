import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, isUuid, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'

// POST { userId, note } — records that an admin re-checked a Verified Operator
// (referral quality, flagged ratio, volume) and decided to keep them. Verified
// Operator status used to be permanent once granted; the affiliate pages now
// flag one for review every VERIFIED_OPERATOR_REVIEW_DAYS, and this resets the clock.
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ userId?: unknown; note?: unknown }>(req)
  if (!body || !isUuid(body.userId)) return badRequest('User ID missing or invalid')
  if (typeof body.note !== 'string' || body.note.trim().length < 3) return badRequest('A note (at least 3 characters) is required')
  const note = body.note.trim().slice(0, 300)

  const { data: p } = await supabase.from('profiles').select('is_verified_operator, is_deleted').eq('id', body.userId).maybeSingle()
  if (!p || p.is_deleted) return NextResponse.json({ error: 'Affiliate not found' }, { status: 404 })
  if (!p.is_verified_operator) return NextResponse.json({ error: 'This affiliate is not a Verified Operator.' }, { status: 409 })

  const { error } = await supabase.from('verified_operator_reviews').insert({ user_id: body.userId, reviewed_by: adminId, note })
  if (error) {
    console.error('[admin/verified-operator-review] insert failed (apply migration 0073)', error)
    return NextResponse.json({ error: 'Could not record the review.' }, { status: 500 })
  }
  await logAdminAction(supabase, { adminId, action: 'verified_operator.review', targetUserId: body.userId, details: { note } })
  return NextResponse.json({ success: true })
}
