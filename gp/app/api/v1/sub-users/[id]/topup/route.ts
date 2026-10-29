import { withApiAuth, readJsonBody, failFrom } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { parseGbAmount } from '@/lib/apiValidation'
import { topupCredential } from '@/lib/credentials'
import { runIdempotent } from '@/lib/idempotency'

// POST /api/v1/sub-users/:id/topup  { "gb_amount": 5 }
// Supports `Idempotency-Key`: a top-up spends balance, so a retry after a
// timeout must not apply it twice. If an earlier attempt with the same key died
// with an unknown outcome the call answers 409 instead of re-running — check the
// sub-user's gb_allocated, then retry with a NEW key if it did not land.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'POST topup', async ({ user, supabase }) => {
    const { id } = await context.params
    const json = await readJsonBody(req)
    if (!json.ok) return json.response
    const gb = parseGbAmount(json.body?.gb_amount)
    if (!gb.ok) return apiError(400, 'invalid_request', gb.error)

    return runIdempotent(req, supabase, user.id, `POST /sub-users/${id}/topup`, JSON.stringify({ gb: gb.value }), async () => {
      const result = await topupCredential(supabase, user.id, id, gb.value, 'api')
      if (!result.ok) return { kind: 'fail', response: failFrom(result), keepClaim: result.outcomeUnknown }
      return {
        kind: 'ok', status: 200,
        body: {
          success: true,
          gb_allocated: result.data.gb_allocated,
          gb_added: result.data.gb_added,
          ...(result.data.warning ? { warning: result.data.warning } : {}),
        },
      }
    }, { allowStaleTakeover: false })
  })
}
