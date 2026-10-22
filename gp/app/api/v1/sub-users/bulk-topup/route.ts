import { withApiAuth, readJsonBody, writeBudgetExceeded } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { parseGbAmount } from '@/lib/apiValidation'
import { topupCredential } from '@/lib/credentials'
import { runIdempotent, parseIdempotencyKey } from '@/lib/idempotency'
import { isUuid } from '@/lib/adminAuth'

const MAX_BULK_TOPUP = 20

// POST /api/v1/sub-users/bulk-topup  { "items": [{ "id": "<sub-user id>", "gb_amount": 5 }, …] }   (max 20)
//
// Each item is an independent top-up (one failing doesn't stop the rest).
// Response: 200 { results: [{ index, id, status: 200|4xx|5xx, gb_allocated, gb_added | error }], succeeded, failed }.
// `Idempotency-Key` is REQUIRED. A top-up spends balance, so this call is never
// re-run when an earlier attempt's outcome is unknown: it answers 409 and you
// check the sub-users' gb_allocated before retrying with a NEW key.
// Each item counts against the 30/min write limit.
export async function POST(req: Request) {
  return withApiAuth(req, 'POST sub-users/bulk-topup', async ({ user, supabase, consumeWrites }) => {
    const idem = parseIdempotencyKey(req)
    if (!idem.ok) return apiError(400, 'invalid_request', idem.error)
    if (!idem.key) return apiError(400, 'invalid_request', 'The Idempotency-Key header is required for bulk requests.')

    const json = await readJsonBody(req)
    if (!json.ok) return json.response
    const items = json.body?.items
    if (!Array.isArray(items) || items.length === 0) return apiError(400, 'invalid_request', 'items must be a non-empty array of { id, gb_amount }.')
    if (items.length > MAX_BULK_TOPUP) return apiError(400, 'invalid_request', `A bulk request can top up at most ${MAX_BULK_TOPUP} sub-users.`)

    const parsed = items.map((it: any) => {
      if (typeof it?.id !== 'string' || !isUuid(it.id)) return { ok: false as const, id: String(it?.id ?? ''), error: 'id must be a sub-user id.' }
      const gb = parseGbAmount(it.gb_amount)
      return gb.ok ? { ok: true as const, id: it.id, gb: gb.value } : { ok: false as const, id: it.id, error: gb.error }
    })

    return runIdempotent(req, supabase, user.id, 'POST /sub-users/bulk-topup', JSON.stringify(parsed.map((p) => (p.ok ? [p.id, p.gb] : null))), async () => {
      // Charged only when the work actually runs (not on an idempotent replay).
      if (!(await consumeWrites(items.length - 1))) return { kind: 'fail', response: writeBudgetExceeded() }
      const results: any[] = []
      for (let i = 0; i < parsed.length; i++) {
        const p = parsed[i]
        if (!p.ok) { results.push({ index: i, id: p.id, status: 400, error: { code: 'invalid_request', message: p.error } }); continue }
        const r = await topupCredential(supabase, user.id, p.id, p.gb, 'api')
        results.push(r.ok
          ? { index: i, id: p.id, status: 200, gb_allocated: r.data.gb_allocated, gb_added: r.data.gb_added, ...(r.data.warning ? { warning: r.data.warning } : {}) }
          : { index: i, id: p.id, status: r.status, error: { code: r.code, message: r.message } })
      }
      const succeeded = results.filter((r) => r.status === 200).length
      return { kind: 'ok', status: 200, body: { results, succeeded, failed: results.length - succeeded } }
    }, { allowStaleTakeover: false })
  })
}
