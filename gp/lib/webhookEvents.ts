// Pure constants — no server imports — so the dashboard (client component),
// the API routes, the delivery engine and the docs all read the same list.
// Keep in sync with the webhook_endpoints_valid_events CHECK constraint
// (migrations 0042 + 0046 + 0054 + 0059 + 0062): an event added here must be added there too, or the
// insert/update is rejected by the database.
export const WEBHOOK_EVENTS = [
  'session_created',
  'session_activated',
  'session_deleted',
  'session_topped_up',
  'session_released',
  'session_low',
  'session_exhausted',
  'session_suspended',
  'session_resumed',
  'auto_topup_triggered',
  'auto_topup_failed',
  'bandwidth_threshold_crossed',
  'bandwidth_exhausted',
  'bandwidth_credited',
  'bandwidth_debited',
  'bandwidth_allocated',
  'bandwidth_reclaimed',
  'bandwidth_refunded',
  'api_key_created',
  'api_key_revoked',
  'api_key_expiring',
] as const

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

export const WEBHOOK_EVENT_LABELS: Record<WebhookEvent, string> = {
  session_created: 'Session created',
  session_activated: 'Pending session activated',
  session_deleted: 'Session deleted',
  session_topped_up: 'Session topped up',
  session_released: 'Unused bandwidth released from a session',
  session_low: 'Session below 20% / 5% bandwidth remaining',
  session_exhausted: 'Session ran out of bandwidth',
  session_suspended: 'Session suspended by GlobProxy',
  session_resumed: 'Session re-enabled',
  auto_topup_triggered: 'Auto top-up triggered',
  auto_topup_failed: 'Auto top-up failed or only partly funded',
  bandwidth_threshold_crossed: 'Bandwidth crossed 80% / 95%',
  bandwidth_exhausted: 'Bandwidth exhausted (100%)',
  bandwidth_credited: 'Bandwidth credited (purchase / allocation / bonus / adjustment)',
  bandwidth_debited: 'Bandwidth debited (support adjustment)',
  bandwidth_allocated: 'Bandwidth allocated to a client (reseller)',
  bandwidth_reclaimed: 'Bandwidth reclaimed by your reseller',
  bandwidth_refunded: 'Purchase refunded (bandwidth clawed back)',
  api_key_created: 'API key created',
  api_key_revoked: 'API key revoked',
  api_key_expiring: 'API key expiring soon',
}

// One line per event for the docs and GET /api/v1/webhooks/events.
export const WEBHOOK_EVENT_DESCRIPTIONS: Record<WebhookEvent, { description: string; data: string[] }> = {
  session_created: { description: 'A sub-user was created (API or dashboard).', data: ['credential_id', 'label', 'protocol', 'session_type', 'gb_allocated', 'country', 'state', 'city', 'asn', 'status', 'source'] },
  session_activated: { description: 'A pending sub-user finished provisioning and is now live.', data: ['credential_id', 'label', 'gb_allocated', 'status'] },
  session_deleted: { description: 'A sub-user was deleted.', data: ['credential_id', 'label', 'gb_allocated', 'gb_used', 'gb_released', 'source'] },
  session_topped_up: { description: 'GB were added to a sub-user (manual top-up).', data: ['credential_id', 'label', 'gb_added', 'gb_allocated', 'source'] },
  session_released: { description: 'Unused GB were returned from a sub-user to your balance (the /release endpoint or the dashboard).', data: ['credential_id', 'label', 'gb_released', 'gb_allocated', 'source'] },
  session_low: { description: 'A sub-user has used 80% or 95% of its allocation (once per tier; not sent while auto-topup is able to refill it).', data: ['credential_id', 'label', 'threshold_pct', 'used_pct', 'gb_allocated', 'gb_used', 'gb_remaining'] },
  session_exhausted: { description: 'A single sub-user used its entire allocation and has stopped connecting (once per exhaustion; not sent while auto-topup is able to refill it — it IS sent if auto-topup is on but the balance cannot fund it).', data: ['credential_id', 'label', 'gb_allocated', 'gb_used'] },
  session_suspended: { description: 'GlobProxy suspended a sub-user (abuse or policy action).', data: ['credential_id', 'label'] },
  session_resumed: { description: 'A suspended sub-user was re-enabled.', data: ['credential_id', 'label'] },
  auto_topup_triggered: { description: 'Auto-topup added bandwidth to a sub-user. partial is true when the balance could only cover part of the configured amount.', data: ['credential_id', 'gb_added', 'gb_allocated', 'partial'] },
  auto_topup_failed: { description: 'Auto-topup could not fully run (once until it recovers). reason is insufficient_balance, partial_funding or session_limit.', data: ['credential_id', 'reason', 'gb_allocated', 'gb_used', 'amount_gb', 'gb_added'] },
  bandwidth_threshold_crossed: { description: 'The share of your account that is committed (allocated into sub-users) crossed 80% or 95%. Checked every 5 minutes. Endpoints that do not also subscribe to bandwidth_exhausted receive it once more at 100% (threshold_pct 100).', data: ['threshold_pct', 'allocated_pct', 'used_pct', 'available_gb', 'total_gb', 'used_gb', 'allocated_gb'] },
  bandwidth_exhausted: { description: 'Available (unallocated) bandwidth reached zero.', data: ['allocated_pct', 'used_pct', 'available_gb', 'total_gb', 'used_gb', 'allocated_gb'] },
  bandwidth_credited: { description: 'Bandwidth was added to your account. source is purchase (order_id, amount_usd), reseller_allocation (transfer_id), referral_bonus (role: referrer or referred) or admin_adjustment (a goodwill credit from support).', data: ['gb_credited', 'source', 'order_id', 'amount_usd', 'transfer_id', 'role'] },
  bandwidth_debited: { description: 'Unallocated bandwidth was removed from your account by a support adjustment. Allocated bandwidth is never taken back this way. (Refund clawbacks arrive as bandwidth_refunded; reseller reclaims as bandwidth_reclaimed.)', data: ['gb_debited', 'source', 'total_gb', 'available_gb'] },
  bandwidth_allocated: { description: 'You allocated bandwidth to a client (resellers).', data: ['transfer_id', 'recipient_email', 'gb', 'note'] },
  bandwidth_reclaimed: { description: 'Unused bandwidth was reclaimed from your account by the reseller who allocated it.', data: ['transfer_id', 'gb_reclaimed', 'gb_remaining'] },
  bandwidth_refunded: { description: 'A purchase was refunded and its bandwidth taken back.', data: ['order_id', 'refund_usd', 'gb_clawed_back', 'gb_not_recoverable', 'fully_refunded'] },
  api_key_created: { description: 'An API key was created on your account.', data: ['key_id', 'label', 'key_prefix', 'scopes', 'expires_at', 'rotated_from'] },
  api_key_revoked: { description: 'An API key was revoked (manually, or immediately on rotation).', data: ['key_id', 'label', 'key_prefix', 'reason', 'replaced_by'] },
  api_key_expiring: { description: 'An API key expires within 7 days.', data: ['key_id', 'label', 'key_prefix', 'expires_at'] },
}

export function isWebhookEvent(v: unknown): v is WebhookEvent {
  return typeof v === 'string' && (WEBHOOK_EVENTS as readonly string[]).includes(v)
}

// Strict version used by the endpoint routes: an unknown name is an ERROR that
// names it. (cleanEventTypes below silently dropped unknown names, so a typo
// like "bandwith_exhausted" created an endpoint subscribed to fewer events and
// still answered 200.)
export function parseEventTypes(input: unknown): { ok: true; value: WebhookEvent[] } | { ok: false; error: string } {
  const hint = `event_types must be a non-empty array of: ${WEBHOOK_EVENTS.join(', ')}`
  if (!Array.isArray(input) || input.length === 0) return { ok: false, error: hint }
  const unknown = input.filter((e) => !isWebhookEvent(e))
  if (unknown.length) return { ok: false, error: `Unknown event type${unknown.length > 1 ? 's' : ''}: ${unknown.map((e) => JSON.stringify(String(e).slice(0, 40))).join(', ')}. ${hint}` }
  return { ok: true, value: [...new Set(input as WebhookEvent[])] }
}

// Returns a de-duplicated, validated list, or null if empty/invalid input.
export function cleanEventTypes(input: unknown): WebhookEvent[] | null {
  if (!Array.isArray(input)) return null
  const out = [...new Set(input)].filter(isWebhookEvent)
  return out.length ? out : null
}
