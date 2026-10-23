-- 0069_api_integrations_pass3.sql
-- Public API & integrations, independent pass 3.
--
--  * New webhook event `auto_topup_updated` (auto top-up settings turned on / off /
--    changed on a sub-user, from the API or the dashboard). The CHECK on
--    webhook_endpoints.event_types is the closed list of events an endpoint may
--    subscribe to, so the new name has to be added here or the API would accept it
--    and the database would refuse the row.
--
-- COMPLETE list as of 0064 plus auto_topup_updated.
alter table public.webhook_endpoints drop constraint if exists webhook_endpoints_valid_events;
alter table public.webhook_endpoints
  add constraint webhook_endpoints_valid_events
  check (event_types <@ array[
    'session_created', 'session_activated', 'session_deleted', 'session_topped_up',
    'session_released', 'session_low', 'session_exhausted',
    'session_suspended', 'session_resumed',
    'session_updated', 'session_password_rotated', 'whitelist_changed',
    'auto_topup_triggered', 'auto_topup_failed', 'auto_topup_updated',
    'bandwidth_threshold_crossed', 'bandwidth_exhausted', 'bandwidth_credited', 'bandwidth_debited',
    'bandwidth_allocated', 'bandwidth_reclaimed', 'bandwidth_refunded',
    'api_key_created', 'api_key_revoked', 'api_key_expiring'
  ]::text[]);

insert into public.schema_migrations (filename) values
  ('0069_api_integrations_pass3.sql')
on conflict do nothing;
