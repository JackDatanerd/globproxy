-- ─────────────────────────────────────────────────────────────────────
-- 0074 · Public API & integrations — independent pass 4
--
--  1. Webhook subscriptions: the wildcard '*' (every event, including ones added
--     later) and three new events — api_key_updated, webhook_endpoint_disabled and
--     reseller_low_stock. COMPLETE list as of 0070 plus those; an event named in
--     lib/webhookEvents.ts but missing here makes the insert/update fail.
--
-- Idempotent. Apply BEFORE / WITH the deploy: until it is applied, saving an
-- endpoint that selects "all events" or one of the new events is rejected by the
-- database (everything already stored keeps working).
-- ─────────────────────────────────────────────────────────────────────

alter table public.webhook_endpoints drop constraint if exists webhook_endpoints_valid_events;
alter table public.webhook_endpoints
  add constraint webhook_endpoints_valid_events
  check (event_types <@ array[
    '*',
    'session_created', 'session_activated', 'session_deleted', 'session_topped_up',
    'session_released', 'session_low', 'session_exhausted',
    'session_suspended', 'session_resumed',
    'session_updated', 'session_password_rotated', 'whitelist_changed',
    'auto_topup_triggered', 'auto_topup_failed', 'auto_topup_updated',
    'bandwidth_threshold_crossed', 'bandwidth_exhausted', 'bandwidth_credited', 'bandwidth_debited',
    'bandwidth_allocated', 'bandwidth_reclaimed', 'bandwidth_refunded',
    'reseller_invitation_created', 'reseller_invitation_expired', 'reseller_invitation_cancelled',
    'api_key_created', 'api_key_revoked', 'api_key_expiring', 'api_key_updated',
    'webhook_endpoint_disabled', 'reseller_low_stock'
  ]::text[]);

insert into public.schema_migrations (filename) values
  ('0074_api_integrations_pass4.sql')
on conflict do nothing;
