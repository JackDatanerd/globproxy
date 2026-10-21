-- 0059_proxy_lifecycle_closeout.sql
-- Proxy lifecycle, audit pass 1 (round 2): supplier secrecy, provisioning
-- honesty, session integrity, auto-allocate continuity, release-unused-GB.
--
--  1. New proxy_credentials columns: supplier-neutral pending_reason,
--     provision_stalled_at, upstream_missing_since, low_alerted_pct.
--  2. Backfill pending_reason for sessions already pending (supplier text in
--     last_provision_error was scrubbed in 0049; columns renamed in 0050).
--  3. Column-level SELECT: customers can no longer read the upstream
--     identifiers, the proxy password, or provisioning internals straight
--     from the REST API (RLS alone only restricts ROWS, not columns).
--  4. proxy_sessions integrity: token format, sticky-only, per-credential
--     caps, suspended owners — enforced in the database, not just the route.
--  5. claim_pending_credentials: never provision for suspended/deleted
--     owners; keep retrying (slowly) instead of silently giving up at 30.
--  6. auto_topup_credential: partial funding when the balance is short.
--  7. set_auto_topup: upper bounds.
--  8. release_credential_gb: hand unused GB back to the account balance.
--  9. Webhook events 'session_released' and 'session_low'.
--
-- Keep supabase/schema.sql in sync (scripts/check-schema-sync.mjs).
-- (Renumbered after other sessions landed 0052-0058 first.)

-- ── 1. Columns ────────────────────────────────────────────────
alter table public.proxy_credentials
  add column if not exists pending_reason          text,
  add column if not exists provision_stalled_at    timestamptz,
  add column if not exists upstream_missing_since  timestamptz,
  add column if not exists low_alerted_pct         smallint;

alter table public.proxy_credentials drop constraint if exists proxy_credentials_pending_reason_valid;
alter table public.proxy_credentials
  add constraint proxy_credentials_pending_reason_valid
  check (pending_reason is null or pending_reason in ('capacity', 'unavailable', 'error'));

alter table public.proxy_credentials drop constraint if exists proxy_credentials_low_alerted_pct_valid;
alter table public.proxy_credentials
  add constraint proxy_credentials_low_alerted_pct_valid
  check (low_alerted_pct is null or low_alerted_pct in (80, 95));

-- ── 2. Backfill ───────────────────────────────────────────────
-- last_provision_error holds only neutral codes (provision_failed /
-- upstream_error_<status> / LIMIT_SYNC — 0049). pending_reason is the
-- customer-facing "why is my session not live yet" value; sessions that were
-- already pending and had failed get the generic reason.
update public.proxy_credentials
set pending_reason = 'error'
where status = 'pending'
  and pending_reason is null
  and last_provision_error is not null
  and last_provision_error <> 'LIMIT_SYNC';

-- ── 3. Column-level SELECT on proxy_credentials ───────────────
-- The "Own or created credentials" policy limits which ROWS a customer can
-- read, but every COLUMN came with them: the upstream sub-user id, the proxy
-- username/password and the provisioning bookkeeping were all readable with
-- the public anon key + the customer's own session — including the password
-- on a password-only session that had not yet passed the MFA gate.
-- The dashboard now reads secrets server-side through the service role,
-- behind the MFA-gated pages; direct REST access gets the safe columns only.
--
-- NOTE: any column added to proxy_credentials later is NOT readable by
-- `authenticated` until it is explicitly granted below (fail-closed).
revoke select on public.proxy_credentials from anon, authenticated;

do $$
declare
  cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
  into cols
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'proxy_credentials'
    and column_name not in (
      'upstream_sub_user_id', 'upstream_username', 'upstream_password',
      'last_provision_error', 'provision_attempts', 'provisioning_claimed_at',
      'usage_synced_at'
    );
  execute format('grant select (%s) on public.proxy_credentials to authenticated', cols);
end
$$;

-- ── 4. proxy_sessions integrity ───────────────────────────────
-- The RLS policies let a customer INSERT/UPDATE their own rows directly via
-- the REST API, which bypassed every check in the sessions route: the
-- per-credential cap, the sticky-only rule, the suspended-account block, and
-- the token format (the token is interpolated into the proxy username).
alter table public.proxy_sessions drop constraint if exists proxy_sessions_token_format;
alter table public.proxy_sessions
  add constraint proxy_sessions_token_format
  check (session_token ~ '^[A-Za-z0-9]{6,32}$') not valid;

create or replace function public.enforce_proxy_session_limits()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_type   text;
  v_owner  uuid;
  v_inactive boolean;
  v_live   integer;
  v_total  integer;
begin
  -- Serialise concurrent inserts for the same credential so the caps below
  -- cannot be raced past.
  perform pg_advisory_xact_lock(hashtextextended('proxy_sessions:' || new.credential_id::text, 0));

  select session_type, user_id into v_type, v_owner
  from public.proxy_credentials where id = new.credential_id;

  if not found or v_owner <> new.user_id then
    raise exception 'Credential not found' using errcode = 'P0002';
  end if;
  if v_type <> 'sticky' then
    raise exception 'Named sessions are only available on sticky credentials' using errcode = '23514';
  end if;

  select coalesce(is_suspended, false) or coalesce(is_deleted, false) into v_inactive
  from public.profiles where id = new.user_id;
  if coalesce(v_inactive, false) then
    raise exception 'Account is not active' using errcode = '42501';
  end if;

  select count(*) filter (where terminated_at is null), count(*)
  into v_live, v_total
  from public.proxy_sessions where credential_id = new.credential_id;

  if v_live >= 200 then
    raise exception 'Session limit reached (200 live named sessions per credential)' using errcode = '23514';
  end if;
  if v_total >= 2000 then
    raise exception 'Too many stored sessions on this credential; remove old terminated ones' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_proxy_session_limits() from public, anon, authenticated;

drop trigger if exists proxy_sessions_enforce_limits on public.proxy_sessions;
create trigger proxy_sessions_enforce_limits
  before insert on public.proxy_sessions
  for each row execute function public.enforce_proxy_session_limits();

-- ── 5. claim_pending_credentials ──────────────────────────────
-- (a) Never provision for a suspended or deleted owner — it used to bring a
--     live, full-cap proxy up for them until the next usage-sync tick capped it.
-- (b) The 30-attempt ceiling is gone: after ~6 days the cron used to give up
--     forever and silently. Backoff already tops out at 6 h, so retrying at
--     that cadence is cheap and heals the moment stock is replenished.
create or replace function public.claim_pending_credentials(
  p_limit integer default 5,
  p_user_id uuid default null,
  p_ignore_backoff boolean default false
)
returns setof public.proxy_credentials
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  return query
  update public.proxy_credentials pc
  set provisioning_claimed_at = now(),
      provision_attempts = pc.provision_attempts + 1
  where pc.id in (
    select c.id from public.proxy_credentials c
    where c.status = 'pending'
      and c.created_by is null
      and (p_user_id is null or c.user_id = p_user_id)
      and not exists (
        select 1 from public.profiles p
        where p.id = c.user_id
          and (coalesce(p.is_suspended, false) or coalesce(p.is_deleted, false))
      )
      and (
        p_ignore_backoff
        or (
          c.provisioning_claimed_at is null
          or c.provisioning_claimed_at < now() - least(
               interval '3 minutes' * power(2, least(c.provision_attempts, 7)),
               interval '6 hours')
        )
      )
      and (c.provisioning_claimed_at is null or c.provisioning_claimed_at < now() - interval '2 minutes')
    order by c.created_at
    limit p_limit
    for update skip locked
  )
  returning pc.*;
end;
$$;

revoke all on function public.claim_pending_credentials(integer, uuid, boolean) from public, anon, authenticated;
grant execute on function public.claim_pending_credentials(integer, uuid, boolean) to service_role;

-- ── 6. auto_topup_credential: partial funding ─────────────────
-- Previously all-or-nothing: with 3 GB of balance and a 5 GB top-up
-- configured, nothing happened and the session ran dry with 3 GB sitting
-- unused. Now it tops up with whatever the balance can cover (minimum
-- 0.01 GB) and reports whether it was partial.
drop function if exists public.auto_topup_credential(uuid, uuid);

create or replace function public.auto_topup_credential(
  p_credential_id uuid,
  p_user_id uuid
)
returns table (new_total numeric, added_gb numeric, partial boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c record;
  v_remaining numeric;
  v_avail numeric;
  v_amount numeric;
  v_total numeric;
begin
  select * into c
  from public.proxy_credentials
  where id = p_credential_id and user_id = p_user_id
  for update;

  if not found then
    raise exception 'Credential not found' using errcode = 'P0002';
  end if;

  if not c.auto_topup_enabled or c.status <> 'active' or c.created_by is not null then
    return;
  end if;

  if c.auto_topup_amount_gb <= c.auto_topup_threshold_gb then
    raise exception 'Auto top-up misconfigured: amount must be greater than threshold' using errcode = 'P0003';
  end if;

  v_remaining := c.gb_allocated - coalesce(c.gb_used, 0);
  if v_remaining > c.auto_topup_threshold_gb then
    return;
  end if;

  select (total_gb - allocated_gb) into v_avail
  from public.bandwidth_accounts where user_id = p_user_id;

  if v_avail is null or v_avail < 0.01 then
    raise exception 'Insufficient bandwidth in your account.' using errcode = 'P0001';
  end if;

  v_amount := least(c.auto_topup_amount_gb, floor(v_avail * 10000) / 10000);

  -- topup_credential re-checks the balance under its own guarded update, so a
  -- concurrent spend between the read above and here still fails cleanly.
  v_total := public.topup_credential(p_credential_id, p_user_id, v_amount);

  return query select v_total, v_amount, (v_amount < c.auto_topup_amount_gb);
end;
$$;

revoke all on function public.auto_topup_credential(uuid, uuid) from public, anon, authenticated;
grant execute on function public.auto_topup_credential(uuid, uuid) to service_role;

-- ── 7. set_auto_topup: upper bounds ───────────────────────────
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
    if p_amount_gb > 100000 or p_threshold_gb > 100000 then
      raise exception 'threshold_gb and amount_gb cannot exceed 100000';
    end if;
  end if;

  update public.proxy_credentials
  set auto_topup_enabled = p_enabled,
      auto_topup_threshold_gb = case when p_enabled then p_threshold_gb else null end,
      auto_topup_amount_gb = case when p_enabled then p_amount_gb else null end,
      auto_topup_insufficient_alerted_at = null
  where id = p_credential_id;
end;
$$;

-- ── 8. release_credential_gb ──────────────────────────────────
-- Hands unused GB on one session back to the account balance without
-- deleting the session. The caller (lib/credentials.ts) supplies the LIVE
-- usage figure; the floor is max(live, synced) + headroom so stale usage can
-- never be "released" back as if it were unspent.
create or replace function public.release_credential_gb(
  p_credential_id uuid,
  p_user_id uuid,
  p_gb numeric,
  p_live_used_gb numeric default null
)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c record;
  v_used numeric;
  v_new numeric;
  v_headroom numeric;
  v_max numeric;
begin
  if p_gb is null or p_gb < 0.01 then
    raise exception 'Release amount must be at least 0.01 GB' using errcode = '22023';
  end if;

  select * into c
  from public.proxy_credentials
  where id = p_credential_id and user_id = p_user_id
  for update;

  if not found then
    raise exception 'Credential not found' using errcode = 'P0002';
  end if;
  if c.created_by is not null then
    raise exception 'This credential was allocated by your reseller and cannot be changed directly. Contact them.' using errcode = '42501';
  end if;
  if c.status not in ('active', 'pending') then
    raise exception 'Only active or pending credentials can release bandwidth.' using errcode = '22023';
  end if;

  v_used := greatest(coalesce(c.gb_used, 0), coalesce(p_live_used_gb, 0));
  v_headroom := case when c.status = 'active' then 0.05 else 0 end;
  v_new := c.gb_allocated - p_gb;
  v_max := greatest(0, floor((c.gb_allocated - v_used - v_headroom - 0.01) * 10000) / 10000);

  if v_new < v_used + v_headroom or v_new < 0.01 then
    raise exception 'Only % GB can be released from this session right now', trim_scale(round(v_max, 4)) using errcode = 'P0004';
  end if;

  if c.auto_topup_enabled and (v_new - v_used) <= coalesce(c.auto_topup_threshold_gb, 0) then
    raise exception 'Releasing that much would immediately trigger auto-allocate. Lower the amount or turn auto-allocate off first.' using errcode = 'P0005';
  end if;

  update public.proxy_credentials
  set gb_allocated = v_new,
      low_alerted_pct = null
  where id = p_credential_id;

  update public.bandwidth_accounts
  set allocated_gb = allocated_gb - p_gb
  where user_id = p_user_id;

  return v_new;
end;
$$;

revoke all on function public.release_credential_gb(uuid, uuid, numeric, numeric) from public, anon, authenticated;
grant execute on function public.release_credential_gb(uuid, uuid, numeric, numeric) to service_role;

-- ── 9. Webhook events ─────────────────────────────────────────
-- Keep in sync with lib/webhookEvents.ts. This is the COMPLETE list as of
-- 0054 plus 'session_released' and 'session_low' — a constraint rewritten
-- from a stale list would silently reject every endpoint subscribed to the
-- events it forgot.
alter table public.webhook_endpoints drop constraint if exists webhook_endpoints_valid_events;
alter table public.webhook_endpoints
  add constraint webhook_endpoints_valid_events
  check (event_types <@ array[
    'session_created', 'session_activated', 'session_deleted', 'session_topped_up',
    'session_released', 'session_low', 'session_exhausted',
    'session_suspended', 'session_resumed',
    'auto_topup_triggered', 'auto_topup_failed',
    'bandwidth_threshold_crossed', 'bandwidth_exhausted', 'bandwidth_credited',
    'bandwidth_allocated', 'bandwidth_reclaimed', 'bandwidth_refunded',
    'api_key_created', 'api_key_revoked', 'api_key_expiring'
  ]::text[]);

insert into public.schema_migrations (filename) values
  ('0059_proxy_lifecycle_closeout.sql')
on conflict do nothing;
