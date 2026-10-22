-- 0062: API & integrations closeout
--
-- 1. 'bandwidth_debited' webhook event (support debits were invisible to
--    integrations). The list below is 0059's, plus that one event — a constraint
--    rewritten from a stale list would silently reject every endpoint subscribed
--    to the events it forgot.
-- 2. proxy_credentials.suspended_reason gains 'customer': a sub-user the owner
--    paused through POST /api/v1/sub-users/:id/pause. Account re-enable only
--    restores NULL/'account', so a paused sub-user stays paused through an
--    account suspension cycle, and only its owner can resume it.

alter table public.webhook_endpoints drop constraint if exists webhook_endpoints_valid_events;
alter table public.webhook_endpoints
  add constraint webhook_endpoints_valid_events
  check (event_types <@ array[
    'session_created', 'session_activated', 'session_deleted', 'session_topped_up',
    'session_released', 'session_low', 'session_exhausted',
    'session_suspended', 'session_resumed',
    'auto_topup_triggered', 'auto_topup_failed',
    'bandwidth_threshold_crossed', 'bandwidth_exhausted', 'bandwidth_credited', 'bandwidth_debited',
    'bandwidth_allocated', 'bandwidth_reclaimed', 'bandwidth_refunded',
    'api_key_created', 'api_key_revoked', 'api_key_expiring'
  ]::text[]);

alter table public.proxy_credentials drop constraint if exists proxy_credentials_suspended_reason_check;
alter table public.proxy_credentials
  add constraint proxy_credentials_suspended_reason_check
  check (suspended_reason is null or suspended_reason in ('account', 'admin', 'deleted', 'customer'));

insert into public.schema_migrations (filename) values
  ('0062_api_integrations_closeout.sql')
on conflict do nothing;
