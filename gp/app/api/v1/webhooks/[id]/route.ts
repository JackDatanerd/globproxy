import { withApiAuth, readJsonBody, failFrom } from '@/lib/apiHelpers'
import { getEndpoint, updateEndpoint, deleteEndpoint } from '@/lib/webhookEndpoints'
import { NextResponse } from 'next/server'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(req: Request, context: Ctx) {
  return withApiAuth(req, 'GET webhook', async ({ user, supabase }) => {
    const { id } = await context.params
    const r = await getEndpoint(supabase, user.id, id)
    return r.ok ? NextResponse.json({ webhook: r.data }) : failFrom(r)
  })
}

export async function PATCH(req: Request, context: Ctx) {
  return withApiAuth(req, 'PATCH webhook', async ({ user, supabase }) => {
    const { id } = await context.params
    const json = await readJsonBody(req)
    if (!json.ok) return json.response
    const r = await updateEndpoint(supabase, user.id, id, json.body)
    return r.ok ? NextResponse.json({ webhook: r.data }) : failFrom(r)
  })
}

export async function DELETE(req: Request, context: Ctx) {
  return withApiAuth(req, 'DELETE webhook', async ({ user, supabase }) => {
    const { id } = await context.params
    const r = await deleteEndpoint(supabase, user.id, id)
    return r.ok ? NextResponse.json({ success: true }) : failFrom(r)
  })
}
