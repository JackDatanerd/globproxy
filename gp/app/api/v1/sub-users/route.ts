import { withApiAuth, readJsonBody, failFrom, parsePage } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { parseCreateCredential } from '@/lib/apiValidation'
import { createCredential, toApiCredential, CRED_COLS } from '@/lib/credentials'
import {
  parseIdempotencyKey, claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey,
} from '@/lib/idempotency'
import { NextResponse } from 'next/server'

// GET /api/v1/sub-users?limit=100&offset=0&status=active
export async function GET(req: Request) {
  return withApiAuth(req, 'GET sub-users', async ({ user, supabase }) => {
    const url = new URL(req.url)
    const { limit, offset } = parsePage(url)
    const status = url.searchParams.get('status')
    if (status && !['pending', 'active', 'suspended'].includes(status)) {
      return apiError(400, 'invalid_request', 'status must be one of: pending, active, suspended.')
    }

    let q = supabase
      .from('proxy_credentials')
      .select(CRED_COLS, { count: 'exact' })
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false }) // stable tiebreak so pages never repeat/skip rows
      .range(offset, offset + limit - 1)
    if (status) q = q.eq('status', status)

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
// instead of creating a second credential and reserving bandwidth twice.
export async function POST(req: Request) {
  return withApiAuth(req, 'POST sub-users', async ({ user, supabase }) => {
    const idem = parseIdempotencyKey(req)
    if (!idem.ok) return apiError(400, 'invalid_request', idem.error)

    const json = await readJsonBody(req)
    if (!json.ok) return json.response
    const parsed = parseCreateCredential(json.body)
    if (!parsed.ok) return apiError(400, 'invalid_request', parsed.error)

    if (idem.key) {
      const claim = await claimIdempotencyKey(supabase, user.id, idem.key, JSON.stringify(parsed.value))
      if (claim.kind === 'replay') {
        return NextResponse.json(claim.body, { status: claim.status, headers: { 'Idempotent-Replayed': 'true' } })
      }
      if (claim.kind === 'mismatch') {
        return apiError(422, 'idempotency_conflict', 'This Idempotency-Key was already used with a different request body.')
      }
      if (claim.kind === 'in_flight') {
        return apiError(409, 'conflict', 'A request with this Idempotency-Key is still being processed. Retry shortly.', { 'Retry-After': '2' })
      }
    }

    const result = await createCredential(supabase, user.id, parsed.value, { source: 'api' })
    if (!result.ok) {
      // Failures are not replayable — free the key so the client can retry
      // (e.g. after buying bandwidth after a 402).
      if (idem.key) await releaseIdempotencyKey(supabase, user.id, idem.key)
      return failFrom(result)
    }

    const body = { ...toApiCredential(result.data.cred), ...(result.data.warning ? { warning: result.data.warning } : {}) }
    if (idem.key) await completeIdempotencyKey(supabase, user.id, idem.key, 201, body)
    return NextResponse.json(body, { status: 201 })
  })
}
