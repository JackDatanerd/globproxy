import { withApiAuth, readJsonBody, writeBudgetExceeded } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { parseCreateCredential, parseCreateAutoTopup } from '@/lib/apiValidation'
import { createCredential, toApiCredential } from '@/lib/credentials'
import { runIdempotent, parseIdempotencyKey } from '@/lib/idempotency'
import { NextResponse } from 'next/server'

const MAX_BULK_CREATE = 10

// POST /api/v1/sub-users/bulk  { "items": [ <same body as POST /sub-users>, … ] }   (max 10)
//
// Creates up to 10 sub-users in one call, each independently: one failing
// (e.g. insufficient bandwidth for the 7th) does not stop or undo the others.
// Response: 200 { results: [{ index, status: 201|4xx|5xx, sub_user | error }], succeeded, failed }.
//
// `Idempotency-Key` is REQUIRED here. Item i is created under the derived key
// "<key>#i", so re-sending the same request after a timeout returns the
// already-created sub-users instead of making duplicates. A call in which EVERY
// item succeeded is stored under the key and replayed; a call with any failed item
// is NOT stored (the key is freed), so re-sending the identical request with the
// same key re-runs only the failed items — the created ones come back as they were.
// Reusing a key with changed items is the client's bug (use a new key).
// Each item counts against the 30/min write limit.
export async function POST(req: Request) {
  return withApiAuth(req, 'POST sub-users/bulk', async ({ user, supabase, consumeWrites }) => {
    const idem = parseIdempotencyKey(req)
    if (!idem.ok) return apiError(400, 'invalid_request', idem.error)
    if (!idem.key) return apiError(400, 'invalid_request', 'The Idempotency-Key header is required for bulk requests.')

    const json = await readJsonBody(req)
    if (!json.ok) return json.response
    const items = json.body?.items
    if (!Array.isArray(items) || items.length === 0) return apiError(400, 'invalid_request', 'items must be a non-empty array of sub-user definitions.')
    if (items.length > MAX_BULK_CREATE) return apiError(400, 'invalid_request', `A bulk request can create at most ${MAX_BULK_CREATE} sub-users.`)

    const parsed = items.map((it) => {
      const p = parseCreateCredential(it)
      if (!p.ok) return p
      const a = parseCreateAutoTopup(it?.auto_topup)
      return a.ok ? { ok: true as const, value: { ...p.value, auto_topup: a.value } } : { ok: false as const, error: a.error }
    })

    return runIdempotent(req, supabase, user.id, 'POST /sub-users/bulk', JSON.stringify(parsed.map((p) => (p.ok ? p.value : null))), async (key) => {
      // Charged only when the work actually runs: a replay of a finished request
      // (a client retry) must not eat the write budget a second time.
      if (!(await consumeWrites(items.length - 1))) return { kind: 'fail', response: writeBudgetExceeded() }
      const results: any[] = []
      for (let i = 0; i < parsed.length; i++) {
        const p = parsed[i]
        if (!p.ok) { results.push({ index: i, status: 400, error: { code: 'invalid_request', message: p.error } }); continue }
        const { auto_topup: autoTopup, ...createInput } = p.value as typeof p.value & { auto_topup: { threshold_gb: number; amount_gb: number } | null }
        const r = await createCredential(supabase, user.id, createInput, { source: 'api', idempotencyKey: `${key}#${i}`, autoTopup })
        results.push(r.ok
          ? { index: i, status: 201, sub_user: { ...toApiCredential(r.data.cred), ...(r.data.warning ? { warning: r.data.warning } : {}) } }
          : { index: i, status: r.status, error: { code: r.code, message: r.message } })
      }
      const succeeded = results.filter((r) => r.status === 201).length
      const body = { results, succeeded, failed: results.length - succeeded }
      // Anything short of full success must stay retryable under the same key, e.g.
      // after buying bandwidth following per-item 402s. Storing it would replay the
      // stale failures for 24 hours.
      if (body.failed > 0) return { kind: 'fail', response: NextResponse.json(body, { status: 200 }) }
      return { kind: 'ok', status: 200, body }
    })
  })
}
