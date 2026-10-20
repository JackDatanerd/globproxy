import { authorizeAdmin, readJson, badRequest, isUuid } from '@/lib/adminAuth'
import { markPayoutPaid } from '@/lib/markPayoutPaid'
import { NextResponse } from 'next/server'

// One action for a whole cycle's payout to one affiliate — not per
// commission. See lib/markPayoutPaid.ts.
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response

  const body = await readJson<{ payoutId?: string; reference?: unknown }>(req)
  if (!body || !isUuid(body.payoutId)) return badRequest('Payout ID missing or invalid')
  if (body.reference != null && typeof body.reference !== 'string') return badRequest('reference must be text')
  const reference = (body.reference ?? '').toString().trim().slice(0, 200)

  const result = await markPayoutPaid(auth.supabase, auth.adminId, body.payoutId, reference)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ success: true })
}
