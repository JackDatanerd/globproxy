import { withApiAuth, readJsonBody, failFrom } from '@/lib/apiHelpers'
import { listEndpoints, createEndpoint } from '@/lib/webhookEndpoints'
import { NextResponse } from 'next/server'

// GET /api/v1/webhooks — the signing secret is never listed.
export async function GET(req: Request) {
  return withApiAuth(req, 'GET webhooks', async ({ user, supabase }) => {
    const r = await listEndpoints(supabase, user.id)
    return r.ok ? NextResponse.json({ webhooks: r.data }) : failFrom(r)
  })
}

// POST /api/v1/webhooks { url, event_types, description? } — the secret is returned once, here.
export async function POST(req: Request) {
  return withApiAuth(req, 'POST webhooks', async ({ user, supabase }) => {
    const json = await readJsonBody(req)
    if (!json.ok) return json.response
    const r = await createEndpoint(supabase, user.id, json.body)
    return r.ok ? NextResponse.json({ webhook: r.data }, { status: 201 }) : failFrom(r)
  })
}
