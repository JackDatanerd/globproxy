import { authorizeAdmin, readJson, badRequest, isUuid } from '@/lib/adminAuth'
import { markPayoutPaid } from '@/lib/markPayoutPaid'
import { anyLeaksSupplier, SUPPLIER_TEXT_ERROR } from '@/lib/supplierGuard'
import { NextResponse } from 'next/server'

const MAX_BATCH = 100

// POST { payoutIds: string[], reference?: string }
// Marks several payouts paid in one go after one real-world batch (e.g. one
// USDT sweep or one bank file). Each payout goes through exactly the same
// atomic claim, audit entry and affiliate email as the single route; a failure
// on one never stops the rest, and every outcome is reported back.
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response

  const body = await readJson<{ payoutIds?: unknown; reference?: unknown; expectedAmounts?: unknown }>(req)
  if (!body || !Array.isArray(body.payoutIds) || body.payoutIds.length === 0) return badRequest('payoutIds must be a non-empty list')
  if (body.payoutIds.length > MAX_BATCH) return badRequest(`At most ${MAX_BATCH} payouts at a time`)
  const ids = Array.from(new Set(body.payoutIds))
  if (!ids.every(isUuid)) return badRequest('payoutIds must all be valid payout IDs')
  if (body.reference != null && typeof body.reference !== 'string') return badRequest('reference must be text')
  const reference = (body.reference ?? '').toString().trim().slice(0, 200)
  // The reference is printed in the affiliate's "payout sent" email.
  if (anyLeaksSupplier(reference)) return badRequest(SUPPLIER_TEXT_ERROR)

  // Optional { payoutId: amountSeenByTheAdmin } — a payout whose amount changed since
  // the admin looked at it (a refund shrank it) is refused, not paid at the new figure.
  const expected: Record<string, number> = {}
  if (body.expectedAmounts != null) {
    if (typeof body.expectedAmounts !== 'object' || Array.isArray(body.expectedAmounts)) return badRequest('expectedAmounts must be an object')
    for (const [k, v] of Object.entries(body.expectedAmounts as Record<string, unknown>)) {
      const n = Number(v)
      if (!isUuid(k) || !Number.isFinite(n) || n <= 0) return badRequest('expectedAmounts must map payout IDs to positive amounts')
      expected[k] = n
    }
  }

  const paid: string[] = []
  const failed: { payoutId: string; error: string }[] = []
  for (const id of ids as string[]) {
    const r = await markPayoutPaid(auth.supabase, auth.adminId, id, reference, { expectedAmountUsd: expected[id] ?? null })
    if (r.ok) paid.push(id)
    else failed.push({ payoutId: id, error: r.error })
  }
  return NextResponse.json({ success: failed.length === 0, paid: paid.length, failed })
}
