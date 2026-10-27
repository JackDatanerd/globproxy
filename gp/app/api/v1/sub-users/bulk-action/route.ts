import { withApiAuth, readJsonBody, writeBudgetExceeded } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { deleteCredential } from '@/lib/credentials'
import { pauseCredential, resumeCredential } from '@/lib/credentialPause'
import { NextResponse } from 'next/server'
import { isUuid } from '@/lib/adminAuth'
import { syncUserUsage } from '@/lib/usageSync'

const MAX_BULK = 20
const BULK_SYNC_MIN = 5 // pauses of more sub-users than this share one whole-account usage sync

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

    // One usage sync for a LARGE batch (see pauseCredential). A whole-account sync walks every active
    // sub-user at the provider (up to ~100 calls) and a small batch counts as only a few writes, so it
    // was a cheap way to multiply provider traffic. Small batches refresh just their own sessions.
    // Only reported as synced when the sync actually succeeded; after a failure each pause refreshes its own session.
    let syncWholeAccount = false
    if (action === 'pause' && ids.length > BULK_SYNC_MIN) {
      syncWholeAccount = await syncUserUsage(user.id).then(() => true, (e) => { console.error('[bulk-action] pre-pause usage sync failed', e); return false })
    }

    const results: any[] = []
    const seen = new Set<string>()
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      if (typeof id !== 'string' || !isUuid(id)) { results.push({ index: i, id: String(id ?? ''), status: 400, error: { code: 'invalid_request', message: 'id must be a sub-user id.' } }); continue }
      if (seen.has(id)) { results.push({ index: i, id, status: 400, error: { code: 'invalid_request', message: 'Duplicate id in this request.' } }); continue }
      seen.add(id)
      try {
        if (action === 'delete') {
          const r = await deleteCredential(supabase, user.id, id, 'api')
          results.push(r.ok ? { index: i, id, status: 200, gb_released: r.data.gb_released } : { index: i, id, status: r.status, error: { code: r.code, message: r.message } })
        } else {
          const r = action === 'pause' ? await pauseCredential(supabase, user.id, id, { usageSynced: syncWholeAccount }) : await resumeCredential(supabase, user.id, id)
          results.push(r.ok ? { index: i, id, status: 200, changed: r.data.changed } : { index: i, id, status: r.status, error: { code: r.code, message: r.message } })
        }
      } catch (e) {
        // A database error on one item must not discard the results of the ones already done, and it is
        // reported as a retryable 500 — never as a 404 ("already gone").
        console.error('[bulk-action] item failed unexpectedly', id, e)
        results.push({ index: i, id, status: 500, error: { code: 'internal_error', message: 'Internal error. Retry this item.' } })
      }
    }
    const succeeded = results.filter((r) => r.status === 200).length
    return NextResponse.json({ results, succeeded, failed: results.length - succeeded })
  })
}
