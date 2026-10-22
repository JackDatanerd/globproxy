import { NextResponse } from 'next/server'
import { withApiAuth, failFrom } from '@/lib/apiHelpers'
import { pauseCredential } from '@/lib/credentialPause'

// POST /api/v1/sub-users/:id/pause — idempotent (repeating it answers 200 with changed:false).
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'POST sub-user pause', async ({ user, supabase }) => {
    const { id } = await context.params
    const r = await pauseCredential(supabase, user.id, id)
    return r.ok ? NextResponse.json(r.data) : failFrom(r)
  })
}
