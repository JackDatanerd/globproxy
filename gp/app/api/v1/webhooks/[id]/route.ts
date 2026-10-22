import { withApiAuth, readJsonBody, failFrom } from '@/lib/apiHelpers'
import { getEndpoint, updateEndpoint, deleteEndpoint } from '@/lib/webhookEndpoints'
import { NextResponse } from 'next/server'
import { auditWebhookChange, hostOf } from '@/lib/integrationAudit'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(req: Request, context: Ctx) {
  return withApiAuth(req, 'GET webhook', async ({ user, supabase }) => {
    const { id } = await context.params
    const r = await getEndpoint(supabase, user.id, id)
    return r.ok ? NextResponse.json({ webhook: r.data }) : failFrom(r)
  })
}

export async function PATCH(req: Request, context: Ctx) {
  return withApiAuth(req, 'PATCH webhook', async ({ user, supabase, key }) => {
    const { id } = await context.params
    const json = await readJsonBody(req)
    if (!json.ok) return json.response
    const r = await updateEndpoint(supabase, user.id, id, json.body)
    if (!r.ok) return failFrom(r)
    const changed = ['url', 'event_types', 'description', 'enabled'].filter((k) => json.body?.[k] !== undefined)
    await auditWebhookChange({ userId: user.id, event: 'webhook_updated', req, via: 'api', webhookId: id, host: hostOf(r.data.url), keyId: key.id, changed })
    return NextResponse.json({ webhook: r.data })
  })
}

export async function DELETE(req: Request, context: Ctx) {
  return withApiAuth(req, 'DELETE webhook', async ({ user, supabase, key }) => {
    const { id } = await context.params
    const r = await deleteEndpoint(supabase, user.id, id)
    if (!r.ok) return failFrom(r)
    await auditWebhookChange({ userId: user.id, event: 'webhook_deleted', req, via: 'api', webhookId: id, keyId: key.id })
    return NextResponse.json({ success: true })
  })
}
