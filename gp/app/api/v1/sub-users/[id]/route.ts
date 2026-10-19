import { withApiAuth, readJsonBody, failFrom } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { deleteCredential, getOwnedCredential, toApiCredential, updateCredentialSettings } from '@/lib/credentials'
import { NextResponse } from 'next/server'

// GET /api/v1/sub-users/:id
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'GET sub-user', async ({ user, supabase }) => {
    const { id } = await context.params
    const cred = await getOwnedCredential(supabase, user.id, id)
    if (!cred) return apiError(404, 'not_found', 'Sub-user not found')
    return NextResponse.json(toApiCredential(cred))
  })
}

// PATCH /api/v1/sub-users/:id — label and connection settings (targeting,
// protocol, session type, sticky duration, endpoint count). Bandwidth is
// changed with /topup; none of this touches the upstream sub-user (targeting
// lives in the connection username), so it takes effect immediately. The
// logic is shared with the dashboard's PATCH — see updateCredentialSettings.
export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'PATCH sub-user', async ({ user, supabase }) => {
    const { id } = await context.params
    const json = await readJsonBody(req)
    if (!json.ok) return json.response

    const result = await updateCredentialSettings(supabase, user.id, id, json.body)
    if (!result.ok) return failFrom(result)
    return NextResponse.json(toApiCredential(result.data.cred))
  })
}

// DELETE /api/v1/sub-users/:id — see lib/credentials.ts deleteCredential for
// the ordering guarantees (upstream delete must succeed first; retry-safe).
export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'DELETE sub-user', async ({ user, supabase }) => {
    const { id } = await context.params
    const result = await deleteCredential(supabase, user.id, id, 'api')
    if (!result.ok) return failFrom(result)
    return NextResponse.json({ success: true, gb_released: result.data.gb_released })
  })
}
