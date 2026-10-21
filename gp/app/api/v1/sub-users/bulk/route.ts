import { withApiAuth, readJsonBody, writeBudgetExceeded } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { parseCreateCredential } from '@/lib/apiValidation'
import { createCredential, toApiCredential } from '@/lib/credentials'
import { runIdempotent, parseIdempotencyKey } from '@/lib/idempotency'

const MAX_BULK_CREATE = 10

// POST /api/v1/sub-users/bulk  { "items": [ <same body as POST /sub-users>, … ] }   (max 10)
//
// Creates up to 10 sub-users in one call, each independently: one failing
// (e.g. insufficient bandwidth for the 7th) does not stop or undo the others.
// Response: 200 { results: [{ index, status: 201|4xx|5xx, sub_user | error }], succeeded, failed }.
//
// `Idempotency-Key` is REQUIRED here. Item i is created under the derived key
// "<key>#i", so re-sending the same request after a timeout returns the
// already-created sub-users instead of making duplicates — and a partial
// failure is safe to retry. Each item counts against the 30/min write limit.
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

    const parsed = items.map((it) => parseCreateCredential(it))
    if (!(await consumeWrites(items.length - 1))) return writeBudgetExceeded()

    return runIdempotent(req, supabase, user.id, 'POST /sub-users/bulk', JSON.stringify(parsed.map((p) => (p.ok ? p.value : null))), async (key) => {
      const results: any[] = []
      for (let i = 0; i < parsed.length; i++) {
        const p = parsed[i]
        if (!p.ok) { results.push({ index: i, status: 400, error: { code: 'invalid_request', message: p.error } }); continue }
        const r = await createCredential(supabase, user.id, p.value, { source: 'api', idempotencyKey: `${key}#${i}` })
        results.push(r.ok
          ? { index: i, status: 201, sub_user: { ...toApiCredential(r.data.cred), ...(r.data.warning ? { warning: r.data.warning } : {}) } }
          : { index: i, status: r.status, error: { code: r.code, message: r.message } })
      }
      const succeeded = results.filter((r) => r.status === 201).length
      return { kind: 'ok', status: 200, body: { results, succeeded, failed: results.length - succeeded } }
    })
  })
}
