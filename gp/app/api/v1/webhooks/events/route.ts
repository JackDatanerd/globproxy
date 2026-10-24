import { withApiAuth } from '@/lib/apiHelpers'
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_LABELS, WEBHOOK_EVENT_DESCRIPTIONS, WEBHOOK_WILDCARD } from '@/lib/webhookEvents'
import { NextResponse } from 'next/server'

// GET /api/v1/webhooks/events — the event catalog: every event_types value you
// can subscribe to, what triggers it, and the keys of its `data` object.
// (`test` is also sent by the "send test" action but is never subscribable.)
// `wildcard` is the one extra value event_types accepts: ["*"] = every event, present and future.
export async function GET(req: Request) {
  return withApiAuth(req, 'GET webhook events', async () =>
    NextResponse.json({
      wildcard: WEBHOOK_WILDCARD,
      events: WEBHOOK_EVENTS.map((name) => ({
        name,
        label: WEBHOOK_EVENT_LABELS[name],
        description: WEBHOOK_EVENT_DESCRIPTIONS[name].description,
        data_fields: WEBHOOK_EVENT_DESCRIPTIONS[name].data,
      })),
    })
  )
}
