import { withApiAuth, readJsonBody, failFrom } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { parseGbAmount } from '@/lib/apiValidation'
import { topupCredential } from '@/lib/credentials'
import { NextResponse } from 'next/server'

// POST /api/v1/sub-users/:id/topup  { "gb_amount": 5 }
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'POST topup', async ({ user, supabase }) => {
    const { id } = await context.params
    const json = await readJsonBody(req)
    if (!json.ok) return json.response
    const gb = parseGbAmount(json.body?.gb_amount)
    if (!gb.ok) return apiError(400, 'invalid_request', gb.error)

    const result = await topupCredential(supabase, user.id, id, gb.value, 'api')
    if (!result.ok) return failFrom(result)
    return NextResponse.json({
      success: true,
      gb_allocated: result.data.gb_allocated,
      gb_added: result.data.gb_added,
      ...(result.data.warning ? { warning: result.data.warning } : {}),
    })
  })
}
