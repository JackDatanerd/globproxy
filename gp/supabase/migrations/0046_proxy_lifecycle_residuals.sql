-- ============================================================
-- 0046 — Proxy lifecycle: residual fixes (independent pass 1)
-- ============================================================
-- Rebased on top of 0040 (proxy_credentials lockdown) and 0042 (API &
-- integrations hardening), which independently fixed the reservation /
-- direct-insert holes, the atomic delete, pending-credential claiming and
-- the SECURITY DEFINER default-privileges gap. This migration only adds what
-- those left open:
--
-- 1. auto_topup_credential(): the "is this still due" decision is made UNDER
--    the row lock. lib/autoTopup.ts used to decide from a snapshot and then
--    call topup_credential() unconditionally, so two overlapping runs (cron
--    tick + admin "sync now", or two ticks) that saw the same snapshot each
--    topped the credential up.
-- 2. set_auto_topup() / set_default_auto_topup(): amount must exceed
--    threshold. Otherwise a credential is "due" again straight after every
--    top-up and the whole balance drains into it on the 5-minute cadence.
-- 3. Per-account cap of 100 active/pending credentials (trigger, advisory-
--    locked like the api_keys / webhook limits in 0042). Each credential is
--    a real Geonode sub-user; nothing bounded them.
-- 4. proxy_credentials.exhausted_alerted_at + the 'session_exhausted'
--    webhook event: one notice per exhaustion of a single credential (the
--    existing 80/95/100% alerts are account-level).

alter table public.proxy_credentials
  add column if not exists exhausted_alerted_at timestamptz;

-- ── 1. Auto top-up decided under the lock ─────────────────────
-- Returns the credential's new gb_allocated, or NULL when nothing was due
-- (disabled, not active, reseller-allocated, or already back above the
-- threshold — e.g. a concurrent run topped it up first).
create or replace function public.auto_topup_credential(
  p_credential_id uuid,
  p_user_id uuid
)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c record;
  v_remaining numeric;
begin
  select * into c
  from public.proxy_credentials
  where id = p_credential_id and user_id = p_user_id
  for update;

  if not found then
    raise exception 'Credential not found' using errcode = 'P0002';
  end if;

  if not c.auto_topup_enabled or c.status <> 'active' or c.created_by is not null then
    return null;
  end if;

  if c.auto_topup_amount_gb <= c.auto_topup_threshold_gb then
    raise exception 'Auto top-up misconfigured: amount must be greater than threshold' using errcode = 'P0003';
  end if;

  v_remaining := c.gb_allocated - coalesce(c.gb_used, 0);
  if v_remaining > c.auto_topup_threshold_gb then
    return null;
  end if;

  return public.topup_credential(p_credential_id, p_user_id, c.auto_topup_amount_gb);
end;
$$;

revoke all on function public.auto_topup_credential(uuid, uuid) from public, anon, authenticated;
grant execute on function public.auto_topup_credential(uuid, uuid) to service_role;

-- ── 2. amount must exceed threshold ───────────────────────────
-- CREATE OR REPLACE resets function-level config, so search_path is restated.
create or replace function public.set_auto_topup(
  p_credential_id uuid,
  p_user_id uuid,
  p_enabled boolean,
  p_threshold_gb numeric,
  p_amount_gb numeric
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_created_by uuid;
begin
  select status, created_by into v_status, v_created_by
  from public.proxy_credentials
  where id = p_credential_id and user_id = p_user_id
  for update;

  if not found then
    raise exception 'Credential not found' using errcode = 'P0002';
  end if;

  if v_created_by is not null then
    raise exception 'This credential was allocated by your reseller — auto-allocate can only be configured on credentials you purchased yourself. Contact them.';
  end if;

  if v_status not in ('active', 'pending') then
    raise exception 'Auto-allocate can only be enabled on an active or pending credential.';
  end if;

  if p_enabled then
    if p_threshold_gb is null or p_threshold_gb < 0 then
      raise exception 'threshold_gb must be 0 or greater';
    end if;
    if p_amount_gb is null or p_amount_gb <= 0 then
      raise exception 'amount_gb must be greater than 0';
    end if;
    if p_amount_gb <= p_threshold_gb then
      raise exception 'amount_gb must be greater than threshold_gb, otherwise the session would be topped up on every check';
    end if;
  end if;

  update public.proxy_credentials
  set auto_topup_enabled = p_enabled,
      -- Disabling clears the threshold/amount rather than leaving stale
      -- numbers behind that a future re-enable might silently inherit.
      auto_topup_threshold_gb = case when p_enabled then p_threshold_gb else null end,
      auto_topup_amount_gb = case when p_enabled then p_amount_gb else null end,
      -- Any change here (on, off, or reconfigured while already on) is a
      -- deliberate fresh start — clear a stale insufficient-balance alert
      -- flag so the next real dip re-alerts instead of inheriting old
      -- suppressed state.
      auto_topup_insufficient_alerted_at = null
  where id = p_credential_id;
end;
$$;

revoke all on function public.set_auto_topup(uuid, uuid, boolean, numeric, numeric) from public, anon, authenticated;
grant execute on function public.set_auto_topup(uuid, uuid, boolean, numeric, numeric) to service_role;

create or replace function public.set_default_auto_topup(
  p_user_id uuid,
  p_enabled boolean,
  p_threshold_gb numeric,
  p_amount_gb numeric
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_enabled then
    if p_threshold_gb is null or p_threshold_gb < 0 then
      raise exception 'threshold_gb must be 0 or greater';
    end if;
    if p_amount_gb is null or p_amount_gb <= 0 then
      raise exception 'amount_gb must be greater than 0';
    end if;
    if p_amount_gb <= p_threshold_gb then
      raise exception 'amount_gb must be greater than threshold_gb';
    end if;
  end if;

  update public.bandwidth_accounts
  set default_auto_topup_enabled = p_enabled,
      default_auto_topup_threshold_gb = case when p_enabled then p_threshold_gb else null end,
      default_auto_topup_amount_gb = case when p_enabled then p_amount_gb else null end
  where user_id = p_user_id;

  if not found then
    raise exception 'Bandwidth account not found' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.set_default_auto_topup(uuid, boolean, numeric, numeric) from public, anon, authenticated;
grant execute on function public.set_default_auto_topup(uuid, boolean, numeric, numeric) to service_role;

-- ── 3. Per-account credential cap ─────────────────────────────
create or replace function public.enforce_credential_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status not in ('active', 'pending') then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('proxy_credentials:' || new.user_id::text));
  if (select count(*) from public.proxy_credentials
      where user_id = new.user_id and status in ('active', 'pending')) >= 100 then
    raise exception 'Session limit reached (100). Delete an unused session first.' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_credential_limit() from public, anon, authenticated;

drop trigger if exists proxy_credentials_enforce_limit on public.proxy_credentials;
create trigger proxy_credentials_enforce_limit
  before insert on public.proxy_credentials
  for each row execute function public.enforce_credential_limit();

-- ── 4. 'session_exhausted' webhook event ──────────────────────
-- Keep in sync with lib/webhookEvents.ts.
alter table public.webhook_endpoints drop constraint if exists webhook_endpoints_valid_events;
alter table public.webhook_endpoints
  add constraint webhook_endpoints_valid_events
  check (event_types <@ array[
    'session_created', 'session_activated', 'session_deleted', 'session_topped_up',
    'session_exhausted',
    'auto_topup_triggered', 'auto_topup_failed',
    'bandwidth_threshold_crossed', 'bandwidth_exhausted', 'bandwidth_credited'
  ]::text[]);

insert into public.schema_migrations (filename) values
  ('0046_proxy_lifecycle_residuals.sql')
on conflict do nothing;
