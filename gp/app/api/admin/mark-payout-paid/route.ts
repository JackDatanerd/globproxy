import { authorizeAdmin, readJson, badRequest, isUuid } from '@/lib/adminAuth'
import { markPayoutPaid } from '@/lib/markPayoutPaid'
import { NextResponse } from 'next/server'

// One action for a whole cycle's payout to one affiliate — not per
// commission. See lib/markPayoutPaid.ts.
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response

  const body = await readJson<{ payoutId?: string; reference?: unknown; overrideSuspended?: unknown; kesAmount?: unknown; expectedAmountUsd?: unknown }>(req)
  if (!body || !isUuid(body.payoutId)) return badRequest('Payout ID missing or invalid')
  if (body.reference != null && typeof body.reference !== 'string') return badRequest('reference must be text')
  const reference = (body.reference ?? '').toString().trim().slice(0, 200)

  // Optional: the shillings actually sent for an M-Pesa payout.
  let kesAmount: number | null = null
  if (body.kesAmount != null && body.kesAmount !== '') {
    kesAmount = Number(body.kesAmount)
    if (!Number.isFinite(kesAmount) || kesAmount <= 0 || kesAmount > 100_000_000) return badRequest('kesAmount must be a positive number of shillings')
  }

  // The amount the admin saw when they clicked. A refund can shrink a payout in between,
  // and the money is sent outside the app — see markPayoutPaid.
  let expectedAmountUsd: number | null = null
  if (body.expectedAmountUsd != null) {
    expectedAmountUsd = Number(body.expectedAmountUsd)
    if (!Number.isFinite(expectedAmountUsd) || expectedAmountUsd <= 0) return badRequest('expectedAmountUsd must be a positive amount')
  }

  const result = await markPayoutPaid(auth.supabase, auth.adminId, body.payoutId, reference, { allowSuspended: body.overrideSuspended === true, kesAmount, expectedAmountUsd })
  if (!result.ok) return NextResponse.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, { status: result.status })
  return NextResponse.json({ success: true })
}
