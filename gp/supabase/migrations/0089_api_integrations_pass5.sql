-- ─────────────────────────────────────────────────────────────────────
-- 0089 · Public API & integrations — independent pass 5
--
--  1. Webhook auto-disable now needs the endpoint to have been failing for a while,
--     not just 50 failed attempts in a row. A burst of events against a receiver that
--     was down for a few minutes (one subscribed to '*' reaches 50 within a single
--     busy minute) used to switch a healthy integration off. The rule is now:
--     50 consecutive failed attempts AND the streak is at least 24 hours old
--     (webhook_endpoints.failing_since, stamped on the first failure of a streak and
--     cleared by any success or by re-enabling). A 410 Gone, or an address that is
--     no longer allowed, still disables immediately.
--  2. New webhook event order_failed (a purchase payment declined / failed): the
--     subscription CHECK constraint must allow it.
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
    'webhook_endpoint_disabled', 'reseller_low_stock',
    'order_failed'
  ]::text[]);

alter table public.webhook_endpoints add column if not exists failing_since timestamptz;

-- Endpoints already mid-streak start their clock at their last failure, so they are not
-- disabled the instant this ships on the strength of a streak with no known start.
update public.webhook_endpoints
   set failing_since = coalesce(last_failure_at, now())
 where consecutive_failures > 0 and failing_since is null;

create or replace function public.record_webhook_attempt(
  p_endpoint_id uuid,
  p_ok boolean,
  p_error text,
  p_disable_threshold integer default 50,
  p_force_disable_reason text default null
)
returns boolean language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_enabled boolean;
  v_failures integer;
  v_since timestamptz;
  v_disable boolean := false;
begin
  select enabled, consecutive_failures, failing_since into v_enabled, v_failures, v_since
  from public.webhook_endpoints where id = p_endpoint_id for update;
  if not found then return false; end if;

  if p_ok then
    update public.webhook_endpoints
    set last_success_at = now(), last_error = null, consecutive_failures = 0, failing_since = null
    where id = p_endpoint_id;
    return false;
  end if;

  v_failures := v_failures + 1;
  v_since := coalesce(v_since, now());
  v_disable := v_enabled and (
    p_force_disable_reason is not null
    or (v_failures >= p_disable_threshold and v_since <= now() - interval '24 hours')
  );

  update public.webhook_endpoints
  set last_failure_at = now(),
      last_error = left(p_error, 500),
      consecutive_failures = v_failures,
      failing_since = v_since,
      enabled = case when v_disable then false else enabled end,
      disabled_at = case when v_disable then now() else disabled_at end,
      disabled_reason = case when v_disable
        then coalesce(p_force_disable_reason, 'Disabled automatically after ' || v_failures || ' consecutive failed deliveries over more than 24 hours')
        else disabled_reason end
  where id = p_endpoint_id;

  return v_disable;
end;
$$;

revoke all on function public.record_webhook_attempt(uuid, boolean, text, integer, text) from public, anon, authenticated;
grant execute on function public.record_webhook_attempt(uuid, boolean, text, integer, text) to service_role;

insert into public.schema_migrations (filename) values
  ('0089_api_integrations_pass5.sql')
on conflict do nothing;
