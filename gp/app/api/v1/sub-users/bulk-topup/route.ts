import { withApiAuth, readJsonBody, writeBudgetExceeded } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { parseGbAmount } from '@/lib/apiValidation'
import { topupCredential } from '@/lib/credentials'
import { runIdempotent, parseIdempotencyKey, runItemOnce, type ItemOutcome } from '@/lib/idempotency'
import { NextResponse } from 'next/server'
import { isUuid } from '@/lib/adminAuth'

const MAX_BULK_TOPUP = 20

// POST /api/v1/sub-users/bulk-topup  { "items": [{ "id": "<sub-user id>", "gb_amount": 5 }, …] }   (max 20)
//
// Each item is an independent top-up (one failing doesn't stop the rest).
// Response: 200 { results: [{ index, id, status: 200|4xx|5xx, gb_allocated, gb_added | error }], succeeded, failed }.
// `Idempotency-Key` is REQUIRED. Item i claims the derived key "<key>#i", so a
// top-up is never applied twice. A call in which every item succeeded is stored and
// replayed. A call with any failed item is NOT stored: re-sending the identical
// request with the same key re-runs only the failed items and replays the finished
// ones. A top-up spends balance, so an item whose earlier attempt's outcome is
// unknown (the worker died mid-item) is never re-run: it answers 409 and you check
// that sub-user's gb_allocated before retrying with a NEW key. The same applies to
// the whole call when it is unknown. Each item counts against the 30/min write limit.
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

    return runIdempotent(req, supabase, user.id, 'POST /sub-users/bulk-topup', JSON.stringify(parsed.map((p) => (p.ok ? [p.id, p.gb] : null))), async (key) => {
      // Charged only when the work actually runs (not on an idempotent replay).
      if (!(await consumeWrites(items.length - 1))) return { kind: 'fail', response: writeBudgetExceeded() }
      const results: any[] = []
      for (let i = 0; i < parsed.length; i++) {
        const p = parsed[i]
        if (!p.ok) { results.push({ index: i, id: p.id, status: 400, error: { code: 'invalid_request', message: p.error } }); continue }
        const run = async (): Promise<ItemOutcome> => {
          const r = await topupCredential(supabase, user.id, p.id, p.gb, 'api')
          return r.ok
            ? { status: 200, body: { id: p.id, gb_allocated: r.data.gb_allocated, gb_added: r.data.gb_added, ...(r.data.warning ? { warning: r.data.warning } : {}) } }
            : { status: r.status, body: { id: p.id, error: { code: r.code, message: r.message } }, keepClaim: r.outcomeUnknown }
        }
        // Without a key there is nothing to derive item keys from — run directly.
        const o = key ? await runItemOnce(supabase, user.id, `${key}#${i}`, 'POST /sub-users/bulk-topup item', `${p.id}:${p.gb}`, run) : await run()
        results.push({ index: i, status: o.status, ...(o.body.id ? {} : { id: p.id }), ...o.body })
      }
      const succeeded = results.filter((r) => r.status === 200).length
      const body = { results, succeeded, failed: results.length - succeeded }
      if (body.failed > 0) return { kind: 'fail', response: NextResponse.json(body, { status: 200 }) }
      return { kind: 'ok', status: 200, body }
    }, { allowStaleTakeover: false })
  })
}
