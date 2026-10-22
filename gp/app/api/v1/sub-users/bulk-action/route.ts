import { withApiAuth, readJsonBody, writeBudgetExceeded } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { deleteCredential } from '@/lib/credentials'
import { pauseCredential, resumeCredential } from '@/lib/credentialPause'
import { NextResponse } from 'next/server'
import { isUuid } from '@/lib/adminAuth'
import { syncUserUsage } from '@/lib/usageSync'

const MAX_BULK = 20

// POST /api/v1/sub-users/bulk-action { "action": "delete" | "pause" | "resume", "ids": ["<sub-user id>", …] }   (max 20)
//
// Each item is independent (one failing doesn't stop the rest), and every action
// is safe to repeat — pause/resume answer ok when already in that state and a
// repeated delete reports 404 for the ones already gone — so no Idempotency-Key
// is needed: if a request times out, simply send it again.
// Response: 200 { results: [{ index, id, status, … | error }], succeeded, failed }.
// delete results carry gb_released; pause/resume results carry changed.
// Each item counts against the 30/min write limit.
export async function POST(req: Request) {
  return withApiAuth(req, 'POST sub-users/bulk-action', async ({ user, supabase, consumeWrites }) => {
    const json = await readJsonBody(req)
    if (!json.ok) return json.response
    const action = json.body?.action
    const ids = json.body?.ids
    if (action !== 'delete' && action !== 'pause' && action !== 'resume') return apiError(400, 'invalid_request', 'action must be "delete", "pause" or "resume".')
    if (!Array.isArray(ids) || ids.length === 0) return apiError(400, 'invalid_request', 'ids must be a non-empty array of sub-user ids.')
    if (ids.length > MAX_BULK) return apiError(400, 'invalid_request', `A bulk request can act on at most ${MAX_BULK} sub-users.`)
    if (!(await consumeWrites(ids.length - 1))) return writeBudgetExceeded()

    // One usage sync for the whole batch (see pauseCredential).
    if (action === 'pause') await syncUserUsage(user.id).catch((e) => console.error('[bulk-action] pre-pause usage sync failed', e))

    const results: any[] = []
    const seen = new Set<string>()
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      if (typeof id !== 'string' || !isUuid(id)) { results.push({ index: i, id: String(id ?? ''), status: 400, error: { code: 'invalid_request', message: 'id must be a sub-user id.' } }); continue }
      if (seen.has(id)) { results.push({ index: i, id, status: 400, error: { code: 'invalid_request', message: 'Duplicate id in this request.' } }); continue }
      seen.add(id)
      if (action === 'delete') {
        const r = await deleteCredential(supabase, user.id, id, 'api')
        results.push(r.ok ? { index: i, id, status: 200, gb_released: r.data.gb_released } : { index: i, id, status: r.status, error: { code: r.code, message: r.message } })
      } else {
        const r = action === 'pause' ? await pauseCredential(supabase, user.id, id, { usageSynced: true }) : await resumeCredential(supabase, user.id, id)
        results.push(r.ok ? { index: i, id, status: 200, changed: r.data.changed } : { index: i, id, status: r.status, error: { code: r.code, message: r.message } })
      }
    }
    const succeeded = results.filter((r) => r.status === 200).length
    return NextResponse.json({ results, succeeded, failed: results.length - succeeded })
  })
}
