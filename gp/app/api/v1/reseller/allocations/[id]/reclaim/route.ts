import { withApiAuth, readJsonBody, failFrom } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { rateLimited } from '@/lib/rateLimit'
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

    const json = await readJsonBody(req).catch(() => ({ ok: true as const, body: {} }))
    const body = json.ok ? json.body : {}
    const input = parseReclaimBody({ ...(body && typeof body === 'object' ? body : {}), transfer_id: id })
    if (!input.ok) return failFrom(input)

    const { data: profile } = await supabase.from('profiles').select('email, full_name, role').eq('id', user.id).maybeSingle()
    if (!profile || !['reseller', 'admin'].includes(profile.role ?? '')) return apiError(403, 'reseller_required', 'Reseller access required.')

    return runIdempotent(req, supabase, user.id, `POST /reseller/allocations/${id}/reclaim`, JSON.stringify(input.data), async () => {
      const limited = await rateLimited(req, 'RESELLER_RATE_LIMITER', `reclaim:${user.id}`)
      if (limited) return { kind: 'fail', response: limited }
      const result = await reclaimAllocation(supabase, { id: user.id, email: profile.email, full_name: profile.full_name }, input.data)
      if (!result.ok) return { kind: 'fail', response: failFrom(result) }
      return { kind: 'ok', status: 200, body: { transfer_id: id, reclaimed_gb: result.data.reclaimed_gb, remaining_gb: result.data.remaining_gb } }
    }, { allowStaleTakeover: false })
  }, { scope: 'allocate' })
}
