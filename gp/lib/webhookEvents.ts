// Pure constants — no server imports — so the dashboard (client component),
// the API routes, the delivery engine and the docs all read the same list.
// Keep in sync with the webhook_endpoints_valid_events CHECK constraint
// (migration 0042): an event added here must be added there too, or the
// insert/update is rejected by the database.
export const WEBHOOK_EVENTS = [
  'session_created',
  'session_activated',
  'session_deleted',
  'session_topped_up',
  'auto_topup_triggered',
  'auto_topup_failed',
  'bandwidth_threshold_crossed',
  'bandwidth_exhausted',
  'bandwidth_credited',
] as const

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

export const WEBHOOK_EVENT_LABELS: Record<WebhookEvent, string> = {
  session_created: 'Session created',
  session_activated: 'Pending session activated',
  session_deleted: 'Session deleted',
  session_topped_up: 'Session topped up',
  auto_topup_triggered: 'Auto top-up triggered',
  auto_topup_failed: 'Auto top-up failed (insufficient balance)',
  bandwidth_threshold_crossed: 'Bandwidth crossed 80% / 95%',
  bandwidth_exhausted: 'Bandwidth exhausted (100%)',
  bandwidth_credited: 'Bandwidth credited (purchase / allocation)',
}

export function isWebhookEvent(v: unknown): v is WebhookEvent {
  return typeof v === 'string' && (WEBHOOK_EVENTS as readonly string[]).includes(v)
}

// Returns a de-duplicated, validated list, or null if empty/invalid input.
export function cleanEventTypes(input: unknown): WebhookEvent[] | null {
  if (!Array.isArray(input)) return null
  const out = [...new Set(input)].filter(isWebhookEvent)
  return out.length ? out : null
}
