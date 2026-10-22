import { withApiAuth, readJsonBody, failFrom } from '@/lib/apiHelpers'
import { listEndpoints, createEndpoint } from '@/lib/webhookEndpoints'
import { NextResponse } from 'next/server'
import { auditWebhookChange, hostOf } from '@/lib/integrationAudit'

// GET /api/v1/webhooks — the signing secret is never listed.
export async function GET(req: Request) {
  return withApiAuth(req, 'GET webhooks', async ({ user, supabase }) => {
    const r = await listEndpoints(supabase, user.id)
    return r.ok ? NextResponse.json({ webhooks: r.data }) : failFrom(r)
  })
}

// POST /api/v1/webhooks { url, event_types, description? } — the secret is returned once, here.
// Logged to the account's security events and e-mailed to the owner (throttled).
export async function POST(req: Request) {
  return withApiAuth(req, 'POST webhooks', async ({ user, supabase, key }) => {
    const json = await readJsonBody(req)
    if (!json.ok) return json.response
    const r = await createEndpoint(supabase, user.id, json.body)
    if (!r.ok) return failFrom(r)
    // API keys can't do the dashboard's 2FA step-up, so the change is logged and
    // the owner told instead — a leaked key must not be able to add a listener silently.
    await auditWebhookChange({ userId: user.id, event: 'webhook_created', req, via: 'api', webhookId: r.data.id, host: hostOf(r.data.url), keyId: key.id })
    return NextResponse.json({ webhook: r.data }, { status: 201 })
  })
}
