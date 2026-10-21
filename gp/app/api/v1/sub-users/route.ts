import { withApiAuth, readJsonBody, failFrom, parsePage, parseDateParam, likeEscape } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { parseCreateCredential, parseCreateAutoTopup } from '@/lib/apiValidation'
import { createCredential, toApiCredential, CRED_COLS } from '@/lib/credentials'
import { runIdempotent } from '@/lib/idempotency'
import { NextResponse } from 'next/server'

// GET /api/v1/sub-users?limit=100&offset=0&status=active&label=acme&country=us&created_after=…&created_before=…
// `label` is a case-insensitive contains-match; `country` is a 2-letter code;
// the dates are ISO 8601.
export async function GET(req: Request) {
  return withApiAuth(req, 'GET sub-users', async ({ user, supabase }) => {
    const url = new URL(req.url)
    const { limit, offset } = parsePage(url)
    const status = url.searchParams.get('status')
    if (status && !['pending', 'active', 'suspended'].includes(status)) {
      return apiError(400, 'invalid_request', 'status must be one of: pending, active, suspended.')
    }

    const label = url.searchParams.get('label')?.trim().slice(0, 100) || null
    const country = url.searchParams.get('country')?.trim().toLowerCase() || null
    if (country && !/^[a-z]{2}$/.test(country)) return apiError(400, 'invalid_request', 'country must be a 2-letter country code.')
    const after = parseDateParam(url, 'created_after')
    const before = parseDateParam(url, 'created_before')
    if (after === undefined || before === undefined) return apiError(400, 'invalid_request', 'created_after / created_before must be ISO 8601 timestamps.')

    let q = supabase
      .from('proxy_credentials')
      .select(CRED_COLS, { count: 'exact' })
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false }) // stable tiebreak so pages never repeat/skip rows
      .range(offset, offset + limit - 1)
    if (status) q = q.eq('status', status)
    if (label) q = q.ilike('label', `%${likeEscape(label)}%`)
    if (country) q = q.eq('country', country)
    if (after) q = q.gte('created_at', after)
    if (before) q = q.lt('created_at', before)

    const { data, count, error } = await q
    if (error) {
      console.error('[v1 GET sub-users] query failed', error)
      return apiError(500, 'internal_error', 'Internal error. Please try again.')
    }

    const total = count ?? (data?.length ?? 0)
    return NextResponse.json({
      sub_users: (data ?? []).map(toApiCredential),
      total, limit, offset,
      has_more: offset + (data?.length ?? 0) < total,
    })
  })
}

// POST /api/v1/sub-users — supports an `Idempotency-Key` header so a retried
// request (timeout, dropped connection) returns the original response
// instead of creating a second credential and reserving bandwidth twice. The
// key is also stamped on the credential row (unique per account), so even a
// retry that races the original — or takes over a stale claim — cannot
// produce a duplicate.
export async function POST(req: Request) {
  return withApiAuth(req, 'POST sub-users', async ({ user, supabase }) => {
    const json = await readJsonBody(req)
    if (!json.ok) return json.response
    const parsed = parseCreateCredential(json.body)
    if (!parsed.ok) return apiError(400, 'invalid_request', parsed.error)

    // Optional auto-allocate at creation (parity with the dashboard, and the
    // `auto_topup` field the OpenAPI document advertises):
    //   "auto_topup": { "threshold_gb": 1, "amount_gb": 5 }
    // Same strict bounds as PATCH /sub-users/:id/auto-topup.
    const auto = parseCreateAutoTopup(json.body?.auto_topup)
    if (!auto.ok) return apiError(400, 'invalid_request', auto.error)
    const autoTopup = auto.value

    return runIdempotent(req, supabase, user.id, 'POST /sub-users', JSON.stringify({ ...parsed.value, auto_topup: autoTopup }), async (key) => {
      const result = await createCredential(supabase, user.id, parsed.value, { source: 'api', idempotencyKey: key, autoTopup })
      if (!result.ok) return { kind: 'fail', response: failFrom(result) }
      const body = { ...toApiCredential(result.data.cred), ...(result.data.warning ? { warning: result.data.warning } : {}) }
      return { kind: 'ok', status: 201, body }
    })
  })
}
