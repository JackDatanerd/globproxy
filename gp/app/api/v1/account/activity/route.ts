import { withApiAuth, failFrom } from '@/lib/apiHelpers'
import { listApiActivity } from '@/lib/apiActivity'
import { NextResponse } from 'next/server'

// GET /api/v1/account/activity?key_id=&limit=50&before=<ISO>
// The mutating calls (POST/PATCH/DELETE) made with this account's API keys over
// the last 30 days: which key, from which IP, which path, what status, and the
// X-Request-Id. Read-only requests are not logged.
export async function GET(req: Request) {
  return withApiAuth(req, 'GET account/activity', async ({ user, supabase }) => {
    const url = new URL(req.url)
    const r = await listApiActivity(supabase, user.id, {
      keyId: url.searchParams.get('key_id'), limit: Number(url.searchParams.get('limit')) || undefined, before: url.searchParams.get('before'), beforeId: url.searchParams.get('before_id'),
    })
    return r.ok ? NextResponse.json(r.data) : failFrom({ status: r.status, code: r.status === 400 ? 'invalid_request' : 'internal_error', message: r.message })
  })
}
