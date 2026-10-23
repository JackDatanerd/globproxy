import { withApiAuth, readOptionalJsonObject, failFrom, asApiRateLimited } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { rateLimited, rateLimitedUser } from '@/lib/rateLimit'
import { parseReclaimBody, reclaimAllocation } from '@/lib/resellerAllocation'
import { runIdempotent, parseIdempotencyKey } from '@/lib/idempotency'

// POST /api/v1/reseller/allocations/:id/reclaim   { "gb": 5 }   (gb optional = everything unused)
// Takes back the UNUSED part of a transfer. Only bandwidth the client has not
// used or committed to a sub-user can move back. Requires the "allocate" scope
// and an `Idempotency-Key` (a retried reclaim must not be applied twice).
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'POST allocation reclaim', async ({ user, supabase }) => {
    const { id } = await context.params
    const idem = parseIdempotencyKey(req)
    if (!idem.ok) return apiError(400, 'invalid_request', idem.error)
    if (!idem.key) return apiError(400, 'invalid_request', 'The Idempotency-Key header is required for reclaims.')

    // The body is optional (no body = reclaim everything unused), but a body that is
    // PRESENT and unreadable must never be mistaken for an absent one: a typo like
    // {"gb": 5 used to fall back to {} and take back the whole unused allocation.
    const json = await readOptionalJsonObject(req)
    if (!json.ok) return json.response
    const input = parseReclaimBody({ ...json.body, transfer_id: id })
    if (!input.ok) return failFrom(input)

    const { data: profile } = await supabase.from('profiles').select('email, full_name, role').eq('id', user.id).maybeSingle()
    if (!profile || !['reseller', 'admin'].includes(profile.role ?? '')) return apiError(403, 'reseller_required', 'Reseller access required.')

    return runIdempotent(req, supabase, user.id, `POST /reseller/allocations/${id}/reclaim`, JSON.stringify(input.data), async () => {
      // Same two limiters as the dashboard route: the address one bounds a source, the
      // per-user one bounds the ACCOUNT (a key can be used from many addresses).
      const limited = (await rateLimited(req, 'RESELLER_RATE_LIMITER', `reclaim:${user.id}`)) ?? (await rateLimitedUser('RESELLER_RATE_LIMITER', user.id, 'reclaim'))
      if (limited) return { kind: 'fail', response: asApiRateLimited(limited) }
      const result = await reclaimAllocation(supabase, { id: user.id, email: profile.email, full_name: profile.full_name }, input.data)
      if (!result.ok) return { kind: 'fail', response: failFrom(result) }
      return { kind: 'ok', status: 200, body: { transfer_id: id, reclaimed_gb: result.data.reclaimed_gb, remaining_gb: result.data.remaining_gb } }
    }, { allowStaleTakeover: false })
  }, { scope: 'allocate' })
}
