// Pure constants — no server imports — so the dashboard (client component),
// the API routes, the delivery engine and the docs all read the same list.
// Keep in sync with the webhook_endpoints_valid_events CHECK constraint
// (migrations 0042 + 0046 + 0054 + 0059 + 0062 + 0064 + 0069 + 0070 + 0074 + 0089): an event added here must be added there too, or the
// insert/update is rejected by the database.
// Sent as `api_version` in every payload so a receiver can tell which shape it is
// parsing if the event format ever has to change incompatibly. Additive today.
export const WEBHOOK_API_VERSION = 'v1'

// An endpoint subscribed to ['*'] receives EVERY subscribable event, including ones
// added later — without it each new event needed every receiver to edit its
// subscription by hand, and it silently heard nothing until it did. ('test' is
// always delivered to the endpoint it is sent to, wildcard or not.)
export const WEBHOOK_WILDCARD = '*'

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
  'session_updated',
  'session_password_rotated',
  'whitelist_changed',
  'auto_topup_triggered',
  'auto_topup_failed',
  'auto_topup_updated',
  'bandwidth_threshold_crossed',
  'bandwidth_exhausted',
  'bandwidth_credited',
  'bandwidth_debited',
  'bandwidth_allocated',
  'reseller_invitation_created',
  'reseller_invitation_expired',
  'reseller_invitation_cancelled',
  'bandwidth_reclaimed',
  'bandwidth_refunded',
  'order_failed',
  'api_key_created',
  'api_key_revoked',
  'api_key_expiring',
  'api_key_updated',
  'webhook_endpoint_disabled',
  'reseller_low_stock',
] as const

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

export const WEBHOOK_EVENT_LABELS: Record<WebhookEvent, string> = {
  session_created: 'Session created',
  session_activated: 'Pending session activated',
  session_deleted: 'Session deleted',
  session_topped_up: 'Session topped up',
  session_released: 'Unused bandwidth released from a session',
  session_low: 'Session crossed a usage alert level (80% / 95% used by default)',
  session_exhausted: 'Session ran out of bandwidth',
  session_suspended: 'Session suspended (paused by you, or by GlobProxy)',
  session_resumed: 'Session re-enabled',
  session_updated: 'Session settings changed (label, targeting, protocol, sticky lifetime)',
  session_password_rotated: 'Session password rotated',
  whitelist_changed: 'IP whitelist changed on a session',
  auto_topup_triggered: 'Auto top-up triggered',
  auto_topup_failed: 'Auto top-up failed or only partly funded',
  auto_topup_updated: 'Auto top-up settings changed on a session',
  bandwidth_threshold_crossed: 'Bandwidth crossed 80% / 95%',
  bandwidth_exhausted: 'Bandwidth exhausted (100%)',
  bandwidth_credited: 'Bandwidth credited (purchase / allocation / bonus / adjustment)',
  bandwidth_debited: 'Bandwidth debited (support adjustment)',
  bandwidth_allocated: 'Bandwidth allocated to a client (reseller)',
  reseller_invitation_created: 'Invitation created for a client without an account (reseller)',
  reseller_invitation_expired: 'Invitation expired unclaimed (reseller)',
  reseller_invitation_cancelled: 'Invitation cancelled (reseller)',
  bandwidth_reclaimed: 'Bandwidth reclaimed by your reseller',
  bandwidth_refunded: 'Purchase refunded (bandwidth clawed back)',
  order_failed: 'Purchase payment failed',
  api_key_created: 'API key created',
  api_key_revoked: 'API key revoked',
  api_key_expiring: 'API key expiring soon',
  api_key_updated: 'API key edited (scopes, allowed IPs, expiry or label)',
  webhook_endpoint_disabled: 'Another webhook endpoint was switched off',
  reseller_low_stock: 'Reseller stock fell below your alert level',
}

// One line per event for the docs and GET /api/v1/webhooks/events.
export const WEBHOOK_EVENT_DESCRIPTIONS: Record<WebhookEvent, { description: string; data: string[] }> = {
  session_created: { description: 'A sub-user was created (API or dashboard).', data: ['credential_id', 'label', 'protocol', 'session_type', 'gb_allocated', 'country', 'state', 'city', 'asn', 'status', 'source'] },
  session_activated: { description: 'A pending sub-user finished provisioning and is now live.', data: ['credential_id', 'label', 'gb_allocated', 'status'] },
  session_deleted: { description: 'A sub-user was deleted.', data: ['credential_id', 'label', 'gb_allocated', 'gb_used', 'gb_released', 'source'] },
  session_topped_up: { description: 'GB were added to a sub-user (manual top-up).', data: ['credential_id', 'label', 'gb_added', 'gb_allocated', 'source'] },
  session_released: { description: 'Unused GB were returned from a sub-user to your balance (the /release endpoint or the dashboard).', data: ['credential_id', 'label', 'gb_released', 'gb_allocated', 'source'] },
  session_low: { description: 'A sub-user has crossed a usage alert level of its allocation (80% and 95% by default; the account owner can change both in Settings) (once per tier; not sent while auto-topup is able to refill it).', data: ['credential_id', 'label', 'threshold_pct', 'used_pct', 'gb_allocated', 'gb_used', 'gb_remaining'] },
  session_exhausted: { description: 'A single sub-user used its entire allocation and has stopped connecting (once per exhaustion; not sent while auto-topup is able to refill it — it IS sent if auto-topup is on but the balance cannot fund it).', data: ['credential_id', 'label', 'gb_allocated', 'gb_used'] },
  session_suspended: { description: 'GlobProxy suspended a sub-user (abuse or policy action, or the owner pausing it). source is admin (a single sub-user), account (the whole account was suspended) or customer (you paused it).', data: ['credential_id', 'label', 'source'] },
  session_resumed: { description: 'A suspended sub-user was re-enabled. source is admin, account (the account was reinstated) or customer.', data: ['credential_id', 'label', 'source'] },
  session_updated: { description: 'A sub-user\'s settings were edited in place (label, targeting, protocol, session type, sticky lifetime, endpoint count). changed lists the fields.', data: ['credential_id', 'label', 'changed', 'protocol', 'session_type', 'sticky_duration', 'country', 'state', 'city', 'asn', 'endpoint_count', 'source'] },
  session_password_rotated: { description: 'A sub-user\'s proxy password was rotated. The new password is never sent in the event.', data: ['credential_id', 'label'] },
  whitelist_changed: { description: 'IPs were added to or removed from a sub-user\'s whitelist.', data: ['credential_id', 'action', 'count', 'source'] },
  auto_topup_triggered: { description: 'Auto-topup added bandwidth to a sub-user. partial is true when the balance could only cover part of the configured amount.', data: ['credential_id', 'gb_added', 'gb_allocated', 'partial'] },
  auto_topup_failed: { description: 'Auto-topup could not fully run (once until it recovers). reason is insufficient_balance, partial_funding, session_limit or error (the session ran out and a temporary problem stopped the top-up).', data: ['credential_id', 'reason', 'gb_allocated', 'gb_used', 'amount_gb', 'gb_added'] },
  auto_topup_updated: { description: 'Auto-topup settings were turned on, off or changed on a sub-user (API or dashboard). threshold_gb and amount_gb are null when it was turned off.', data: ['credential_id', 'enabled', 'threshold_gb', 'amount_gb', 'source'] },
  bandwidth_threshold_crossed: { description: 'The share of your account that is committed (allocated into sub-users) crossed 80% or 95%. Checked every 5 minutes. Endpoints that do not also subscribe to bandwidth_exhausted receive it once more at 100% (threshold_pct 100).', data: ['threshold_pct', 'allocated_pct', 'used_pct', 'available_gb', 'total_gb', 'used_gb', 'allocated_gb'] },
  bandwidth_exhausted: { description: 'Available (unallocated) bandwidth reached zero.', data: ['allocated_pct', 'used_pct', 'available_gb', 'total_gb', 'used_gb', 'allocated_gb'] },
  bandwidth_credited: { description: 'Bandwidth was added to your account. source is purchase (order_id, amount_usd), reseller_allocation (transfer_id), referral_bonus (role: referrer or referred) or admin_adjustment (a goodwill credit from support).', data: ['gb_credited', 'source', 'order_id', 'amount_usd', 'transfer_id', 'role'] },
  bandwidth_debited: { description: 'Unallocated bandwidth was removed from your account: source is admin_adjustment (a support adjustment) or referral_bonus_reversed (a referral GB bonus taken back because the order behind it was refunded; role: referrer or referred). Allocated bandwidth is never taken back this way. (Purchase refund clawbacks arrive as bandwidth_refunded; reseller reclaims as bandwidth_reclaimed.)', data: ['gb_debited', 'source', 'total_gb', 'available_gb', 'role'] },
  bandwidth_allocated: { description: 'You allocated bandwidth to a client (resellers).', data: ['transfer_id', 'recipient_email', 'gb', 'note'] },
  reseller_invitation_created: { description: 'You allocated to an address with no confirmed account yet (resellers): the stock is reserved. topped_up is true when it was added to an invitation already open for that address.', data: ['pending_id', 'recipient_email', 'gb', 'total_gb', 'expires_at', 'topped_up'] },
  reseller_invitation_expired: { description: 'An invitation was not claimed within 30 days and its stock returned to you (resellers).', data: ['pending_id', 'recipient_email', 'gb'] },
  reseller_invitation_cancelled: { description: 'An invitation was cancelled (by you, the API or support) and its stock returned to you (resellers).', data: ['pending_id', 'recipient_email', 'gb', 'source'] },
  bandwidth_reclaimed: { description: 'Unused bandwidth was reclaimed from your account by the reseller who allocated it.', data: ['transfer_id', 'gb_reclaimed', 'gb_remaining'] },
  bandwidth_refunded: { description: 'A purchase was refunded and its bandwidth taken back.', data: ['order_id', 'refund_usd', 'gb_clawed_back', 'gb_not_recoverable', 'fully_refunded'] },
  order_failed: { description: 'A purchase payment failed or was declined; nothing was charged and no bandwidth was added. Start a new order with POST /orders to retry. reason is the payment provider\'s decline text when it gave one.', data: ['order_id', 'gb', 'amount_usd', 'reason'] },
  api_key_created: { description: 'An API key was created on your account.', data: ['key_id', 'label', 'key_prefix', 'scopes', 'expires_at', 'rotated_from'] },
  api_key_revoked: { description: 'An API key was revoked. reason is "manual" (one key revoked), "revoke_all" (the panic button) or "rotated" (an old key revoked immediately by a rotation; replaced_by is the new key id).', data: ['key_id', 'label', 'key_prefix', 'reason', 'replaced_by'] },
  api_key_expiring: { description: 'An API key expires within 7 days.', data: ['key_id', 'label', 'key_prefix', 'expires_at'] },
  api_key_updated: { description: 'An API key was edited (label, scopes, allowed IPs or expiry). changed lists the fields; widened is true when the edit made the key more powerful (a scope added, IP restrictions removed or relaxed, or the expiry extended). The key itself is never sent.', data: ['key_id', 'label', 'key_prefix', 'changed', 'widened', 'scopes', 'expires_at'] },
  webhook_endpoint_disabled: { description: 'One of your webhook endpoints was switched off automatically (repeated delivery failures, a 410 Gone, or an address that is no longer allowed). Delivered to your OTHER endpoints, since the disabled one can no longer receive anything. reason says why.', data: ['webhook_id', 'url', 'reason'] },
  reseller_low_stock: { description: 'Your available reseller stock fell below the low-stock alert level you set (resellers). Sent once until stock rises above the level again.', data: ['available_gb', 'low_stock_gb'] },
}

export type WebhookSubscription = WebhookEvent | typeof WEBHOOK_WILDCARD

// Does an endpoint with these event_types receive `event`? The single place that
// knows what the wildcard means.
export function subscribesTo(eventTypes: readonly string[] | null | undefined, event: string): boolean {
  return !!eventTypes && (eventTypes.includes(WEBHOOK_WILDCARD) || eventTypes.includes(event))
}

export function isWebhookEvent(v: unknown): v is WebhookEvent {
  return typeof v === 'string' && (WEBHOOK_EVENTS as readonly string[]).includes(v)
}

// Strict version used by the endpoint routes: an unknown name is an ERROR that
// names it. (cleanEventTypes below silently dropped unknown names, so a typo
// like "bandwith_exhausted" created an endpoint subscribed to fewer events and
// still answered 200.)
export function parseEventTypes(input: unknown): { ok: true; value: WebhookSubscription[] } | { ok: false; error: string } {
  const hint = `event_types must be a non-empty array of: ${WEBHOOK_EVENTS.join(', ')} — or [\"*\"] for every event`
  if (!Array.isArray(input) || input.length === 0) return { ok: false, error: hint }
  // "*" means everything, so alongside other names it adds nothing: it is stored on
  // its own (and the names are still checked, so a typo next to it is still an error).
  const unknown = input.filter((e) => e !== WEBHOOK_WILDCARD && !isWebhookEvent(e))
  if (unknown.length) return { ok: false, error: `Unknown event type${unknown.length > 1 ? 's' : ''}: ${unknown.map((e) => JSON.stringify(String(e).slice(0, 40))).join(', ')}. ${hint}` }
  if (input.includes(WEBHOOK_WILDCARD)) return { ok: true, value: [WEBHOOK_WILDCARD] }
  return { ok: true, value: [...new Set(input as WebhookEvent[])] }
}

// Returns a de-duplicated, validated list, or null if empty/invalid input.
export function cleanEventTypes(input: unknown): WebhookEvent[] | null {
  if (!Array.isArray(input)) return null
  const out = [...new Set(input)].filter(isWebhookEvent)
  return out.length ? out : null
}
