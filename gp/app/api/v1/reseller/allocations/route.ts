import { withApiAuth, readJsonBody, failFrom, asApiRateLimited } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { rateLimited, rateLimitedUser } from '@/lib/rateLimit'
import { parseAllocationBody, allocateBandwidth, listTransfers } from '@/lib/resellerAllocation'
import { runIdempotent, parseIdempotencyKey } from '@/lib/idempotency'
import { NextResponse } from 'next/server'

// Reseller bandwidth allocation API. Requires an API key with the "allocate"
// scope (reads: "read"), pinned to specific source IPs — see /docs/api. API keys
// skip the dashboard's 2FA step-up, which is why these are their own scope and
// why every allocation needs an Idempotency-Key.

// GET /api/v1/reseller/allocations?limit=50&before=<next_before>&before_id=<next_before_id>
// Your transfer history, newest first (the same data as the dashboard's
// Transfers page and CSV export).
export async function GET(req: Request) {
  return withApiAuth(req, 'GET allocations', async ({ user, supabase }) => {
    const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle()
    if (!me || !['reseller', 'admin'].includes(me.role ?? '')) return apiError(403, 'reseller_required', 'Reseller access required.')
    const url = new URL(req.url)
    const r = await listTransfers(supabase, user.id, { limit: Number(url.searchParams.get('limit')) || undefined, before: url.searchParams.get('before'), beforeId: url.searchParams.get('before_id') })
    return r.ok ? NextResponse.json(r.data) : failFrom(r)
  })
}

// POST /api/v1/reseller/allocations
//   { "recipient_email": "client@example.com", "gb_allocated": 25, "note": "March top-up" }
// Moves GB from your stock to a client account. An address with no confirmed account
// yet gets an invitation instead: the stock is reserved, `status` is "pending_signup"
// and the GB lands when they sign up and confirm (30 days, then it returns to you). `Idempotency-Key`
// is REQUIRED: a transfer moves bandwidth between accounts, so a retry after a
// timeout must never apply it twice. If an earlier attempt with the same key
// finished with an unknown outcome the call answers 409 — check
// GET /allocations, then retry with a NEW key if it did not land.
export async function POST(req: Request) {
  return withApiAuth(req, 'POST allocations', async ({ user, supabase }) => {
    const idem = parseIdempotencyKey(req)
    if (!idem.ok) return apiError(400, 'invalid_request', idem.error)
    if (!idem.key) return apiError(400, 'invalid_request', 'The Idempotency-Key header is required for allocations.')

    const json = await readJsonBody(req)
    if (!json.ok) return json.response
    const input = parseAllocationBody(json.body)
    if (!input.ok) return failFrom(input)

    const { data: profile } = await supabase.from('profiles').select('email, full_name, role').eq('id', user.id).maybeSingle()
    if (!profile || !['reseller', 'admin'].includes(profile.role ?? '')) return apiError(403, 'reseller_required', 'Reseller access required.')

    return runIdempotent(req, supabase, user.id, 'POST /reseller/allocations', JSON.stringify(input.data), async () => {
      // Same shared throttle as the dashboard (each call can e-mail a registered
      // address, so dust-sized allocations must not become an e-mail cannon).
      // Inside the idempotent section so a replayed request doesn't spend it.
      // Both limiters, like the dashboard route: per address AND per account (an
      // allocation key can be used from any address inside its allowlist).
      const limited = (await rateLimited(req, 'RESELLER_RATE_LIMITER', `allocate:${user.id}`)) ?? (await rateLimitedUser('RESELLER_RATE_LIMITER', user.id, 'allocate'))
      if (limited) return { kind: 'fail', response: asApiRateLimited(limited) }
      const result = await allocateBandwidth(supabase, { id: user.id, email: profile.email, full_name: profile.full_name }, input.data)
      // The shared lib answers 400 (the dashboard's long-standing status); over
      // the API a stock shortfall is 402, exactly as for POST /sub-users.
      if (!result.ok) return { kind: 'fail', response: failFrom(result.code === 'insufficient_bandwidth' ? { ...result, status: 402 } : result) }
      return { kind: 'ok', status: 201, body: { transfer_id: result.data.transfer_id, status: result.data.status, pending_id: result.data.pending_id, expires_at: result.data.expires_at, gb: result.data.gb, recipient_email: result.data.recipient_email } }
    }, { allowStaleTakeover: false })
  }, { scope: 'allocate' })
}
