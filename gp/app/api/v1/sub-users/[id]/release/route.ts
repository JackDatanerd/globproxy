import { withApiAuth, readJsonBody, failFrom } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { parseGbAmount } from '@/lib/apiValidation'
import { releaseCredentialBandwidth } from '@/lib/credentials'
import { NextResponse } from 'next/server'

// POST /api/v1/sub-users/:id/release  { "gb_amount": 2 }
// Returns unused GB on this sub-user to the account balance without deleting
// it. Limited to what is genuinely unused: the live usage figure plus a small
// safety margin is always kept.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'POST release', async ({ user, supabase }) => {
    const { id } = await context.params
    const json = await readJsonBody(req)
    if (!json.ok) return json.response
    const gb = parseGbAmount(json.body?.gb_amount)
    if (!gb.ok) return apiError(400, 'invalid_request', gb.error)

    const result = await releaseCredentialBandwidth(supabase, user.id, id, gb.value, 'api')
    if (!result.ok) return failFrom(result)
    return NextResponse.json({
      success: true,
      gb_allocated: result.data.gb_allocated,
      gb_released: result.data.gb_released,
      max_releasable_gb: result.data.max_releasable_gb,
      ...(result.data.warning ? { warning: result.data.warning } : {}),
    })
  })
}
