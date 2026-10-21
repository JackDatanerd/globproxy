import { withApiAuth, failFrom } from '@/lib/apiHelpers'
import { rotateCredentialPassword } from '@/lib/credentials'
import { NextResponse } from 'next/server'

// POST /api/v1/sub-users/:id/rotate-password
// Replaces the sub-user's proxy password; the previous one stops working.
// Returns the new password (also visible on GET /sub-users/:id).
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'POST rotate-password', async ({ user, supabase }) => {
    const { id } = await context.params
    const result = await rotateCredentialPassword(supabase, user.id, id)
    if (!result.ok) return failFrom(result)
    return NextResponse.json({ success: true, password: result.data.password })
  })
}
