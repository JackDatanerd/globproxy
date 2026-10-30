import { withApiAuth, readOptionalJsonObject, writeBudgetExceeded } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { redeliverFailedWebhooks } from '@/lib/webhooks'
import { NextResponse } from 'next/server'

// POST /api/v1/webhooks/:id/deliveries/redeliver-failed   { "limit": 5 }   (body optional)
// Catch-up after an outage: re-sends this endpoint's failed deliveries, oldest first
// (same event ids and bodies, fresh signature timestamps). At most `limit` (1–10,
// default 5) per call, and it stops after two failures in a row — call it again
// while `more_failed` is true. Each delivery actually sent counts as one write against
// the key's rate limit.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'POST webhook redeliver-failed', async ({ user, consumeWrites }) => {
    const { id } = await context.params
    const json = await readOptionalJsonObject(req)
    if (!json.ok) return json.response
    let limit = 5
    if (json.body.limit !== undefined) {
      limit = Number(json.body.limit)
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) return apiError(400, 'invalid_request', 'limit must be a whole number from 1 to 10.')
    }
    // The request itself already counts as one write; each further delivery in the batch is charged
    // once the batch size is known, so a nearly empty queue does not burn the whole `limit`.
    const r = await redeliverFailedWebhooks(user.id, id, limit, async (n) => n <= 1 || (await consumeWrites(n - 1)))
    if (!r.ok && r.budgetExceeded) return writeBudgetExceeded()
    if (!r.ok) return r.error === 'Webhook not found' ? apiError(404, 'not_found', r.error) : apiError(500, 'internal_error', r.error)
    return NextResponse.json({ attempted: r.attempted, succeeded: r.succeeded, more_failed: r.more_failed, stopped_early: r.stopped_early })
  })
}
