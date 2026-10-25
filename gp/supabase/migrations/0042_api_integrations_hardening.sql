-- ============================================================
-- 0042 — Public API & integrations hardening (audit section 6)
-- ============================================================
-- Safe to run against the live DB: idempotent, additive except for the
-- intentional lock-down in section 1b and the api_keys UPDATE policy drop
-- in section 2. Apply AFTER 0040 and 0041.

-- ── 1. reserve/release_credential_bandwidth ────────────────────────────
-- Already locked to service_role by 0040_proxy_credentials_lockdown.sql (the
-- same hole was found independently); nothing to do here. Section 1b at the
-- end is idempotent over them anyway.

-- ── 2. api_keys: scopes, expiry, last-used IP, key cap ──────────────
alter table public.api_keys add column if not exists scopes       text[] not null default array['read','write']::text[];
alter table public.api_keys add column if not exists expires_at   timestamptz;
alter table public.api_keys add column if not exists last_used_ip text;
-- Optional source-IP allowlist (exact IPv4/IPv6 addresses or IPv4 CIDR). Empty = any IP.
alter table public.api_keys add column if not exists allowed_ips text[] not null default '{}'::text[];

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'api_keys_valid_scopes') then
    alter table public.api_keys
      add constraint api_keys_valid_scopes
      check (scopes <@ array['read','write']::text[] and cardinality(scopes) > 0);
  end if;
end $$;

-- Revocation now goes through /api/dashboard/api-keys with the admin
-- client after an explicit ownership check. The old owner-UPDATE policy
-- let a key's owner rewrite any column (scopes, expires_at, label) of a
-- revoked row directly from the browser, and re-revoking overwrote the
-- original revoked_at. No client write policy remains.
drop policy if exists "Users can revoke own api keys" on public.api_keys;

create or replace function public.enforce_api_key_limit()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtext('api_keys:' || new.user_id::text));
  if (select count(*) from public.api_keys
      where user_id = new.user_id and revoked_at is null) >= 25 then
    raise exception 'Maximum of 25 active API keys per account' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists api_keys_enforce_limit on public.api_keys;
create trigger api_keys_enforce_limit
  before insert on public.api_keys
  for each row execute function public.enforce_api_key_limit();

-- ── 3. Webhooks: more events, delivery log, retries, auto-disable ───
alter table public.webhook_endpoints add column if not exists description          text;
alter table public.webhook_endpoints add column if not exists consecutive_failures integer not null default 0;
alter table public.webhook_endpoints add column if not exists disabled_at          timestamptz;
alter table public.webhook_endpoints add column if not exists disabled_reason      text;

alter table public.webhook_endpoints drop constraint if exists webhook_endpoints_valid_events;
alter table public.webhook_endpoints
  add constraint webhook_endpoints_valid_events
  check (event_types <@ array[
    'session_created', 'session_activated', 'session_deleted', 'session_topped_up',
    'auto_topup_triggered', 'auto_topup_failed',
    'bandwidth_threshold_crossed', 'bandwidth_exhausted', 'bandwidth_credited'
  ]::text[]);

-- The 10-endpoint cap was a count-then-insert in the route (racy).
create or replace function public.enforce_webhook_endpoint_limit()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtext('webhook_endpoints:' || new.user_id::text));
  if (select count(*) from public.webhook_endpoints where user_id = new.user_id) >= 10 then
    raise exception 'Maximum of 10 webhook endpoints per account' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists webhook_endpoints_enforce_limit on public.webhook_endpoints;
create trigger webhook_endpoints_enforce_limit
  before insert on public.webhook_endpoints
  for each row execute function public.enforce_webhook_endpoint_limit();

-- One row per (event, endpoint). `payload` is the exact JSON body that is
-- signed, so retries and manual redeliveries send byte-identical bodies.
create table if not exists public.webhook_deliveries (
  id               uuid default uuid_generate_v4() primary key,
  endpoint_id      uuid not null references public.webhook_endpoints(id) on delete cascade,
  user_id          uuid not null references public.profiles(id) on delete cascade,
  event_id         uuid not null,
  event_type       text not null,
  payload          text not null,
  status           text not null default 'retrying' check (status in ('succeeded','retrying','failed')),
  attempts         integer not null default 0,
  next_attempt_at  timestamptz,
  last_attempt_at  timestamptz,
  response_status  integer,
  last_error       text,
  duration_ms      integer,
  created_at       timestamptz not null default now()
);

create index if not exists webhook_deliveries_endpoint_idx
  on public.webhook_deliveries (endpoint_id, created_at desc);
create index if not exists webhook_deliveries_user_event_idx
  on public.webhook_deliveries (user_id, event_type, created_at desc);
create index if not exists webhook_deliveries_due_idx
  on public.webhook_deliveries (next_attempt_at) where status = 'retrying';

alter table public.webhook_deliveries enable row level security;

drop policy if exists "Users can view own webhook deliveries" on public.webhook_deliveries;
create policy "Users can view own webhook deliveries"
  on public.webhook_deliveries for select
  using (auth.uid() = user_id);

-- Atomic success/failure bookkeeping on the endpoint; auto-disables after
-- p_disable_threshold consecutive failed attempts. Returns true only on
-- the call that flipped enabled -> false (so the owner is emailed once).
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
  v_disable boolean := false;
begin
  select enabled, consecutive_failures into v_enabled, v_failures
  from public.webhook_endpoints where id = p_endpoint_id for update;
  if not found then return false; end if;

  if p_ok then
    update public.webhook_endpoints
    set last_success_at = now(), last_error = null, consecutive_failures = 0
    where id = p_endpoint_id;
    return false;
  end if;

  v_failures := v_failures + 1;
  v_disable := v_enabled and (p_force_disable_reason is not null or v_failures >= p_disable_threshold);

  update public.webhook_endpoints
  set last_failure_at = now(),
      last_error = left(p_error, 500),
      consecutive_failures = v_failures,
      enabled = case when v_disable then false else enabled end,
      disabled_at = case when v_disable then now() else disabled_at end,
      disabled_reason = case when v_disable
        then coalesce(p_force_disable_reason, 'Disabled automatically after ' || v_failures || ' consecutive failed deliveries')
        else disabled_reason end
  where id = p_endpoint_id;

  return v_disable;
end;
$$;

revoke all on function public.record_webhook_attempt(uuid, boolean, text, integer, text) from public, anon, authenticated;
grant execute on function public.record_webhook_attempt(uuid, boolean, text, integer, text) to service_role;

-- Bandwidth-threshold webhooks now run from their own 5-minute task
-- (previously piggybacked on the once-a-day email run), so they need
-- their own de-dupe flags independent of the email flags.
alter table public.bandwidth_accounts add column if not exists wh_alerted_80_at  timestamptz;
alter table public.bandwidth_accounts add column if not exists wh_alerted_95_at  timestamptz;
alter table public.bandwidth_accounts add column if not exists wh_alerted_100_at timestamptz;

-- ── 4. Pending-credential provisioning retries ──────────────────────
-- A credential created while upstream was unreachable stayed 'pending'
-- until the owner's next *purchase* (lib/bandwidth.ts) — API users who
-- never buy again were stuck forever. The new 'provision' cron task
-- retries them with backoff; this claim makes concurrent runs (cron +
-- purchase path) safe so one credential never gets two upstream sub-users.
alter table public.proxy_credentials add column if not exists provisioning_claimed_at timestamptz;
alter table public.proxy_credentials add column if not exists provision_attempts      integer not null default 0;
alter table public.proxy_credentials add column if not exists last_provision_error    text;
alter table public.proxy_credentials add column if not exists usage_synced_at         timestamptz;

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
      and (
        p_ignore_backoff
        or (
          c.provision_attempts < 30
          and (
            c.provisioning_claimed_at is null
            or c.provisioning_claimed_at < now() - least(
                 interval '3 minutes' * power(2, least(c.provision_attempts, 7)),
                 interval '6 hours')
          )
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

-- ── 5. Idempotency keys for POST /api/v1/sub-users ──────────────────
create table if not exists public.api_idempotency_keys (
  user_id          uuid not null references public.profiles(id) on delete cascade,
  key              text not null,
  request_hash     text not null,
  status           text not null default 'in_progress' check (status in ('in_progress','completed')),
  response_status  integer,
  response_body    jsonb,
  created_at       timestamptz not null default now(),
  primary key (user_id, key)
);
create index if not exists api_idempotency_keys_created_idx on public.api_idempotency_keys (created_at);
alter table public.api_idempotency_keys enable row level security;
-- No policies: service role only.

-- ── 1b. Every other SECURITY DEFINER function: close the same hole ──────
-- Found while testing the reserve/release hole against a database seeded with Supabase's
-- default grants. Migration 0012 (and the functions added after it) revoked
-- EXECUTE `from public` only. Per 0012's own description of the platform,
-- Supabase's default project setup ALSO grants EXECUTE on new functions
-- *directly* to anon / authenticated / service_role (ALTER DEFAULT
-- PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon, authenticated,
-- service_role) — and `revoke ... from public` does not touch a direct
-- grant. On such a database every one of these stays callable from the
-- browser console by any logged-in user, or even by an anonymous visitor
-- holding only the public anon key:
--   credit_bandwidth (mints free bandwidth into any account),
--   claim_and_credit_order, apply_order_refund, allocate_reseller_bandwidth,
--   archive_credential_used_gb, topup_credential, set_auto_topup,
--   set_default_auto_topup, bulk_update_credential_usage,
--   recalculate_bandwidth_accounts, the affiliate/referral payout
--   functions, and the MFA bookkeeping functions (mfa_consume_totp,
--   wipe_mfa, confirm_totp_enrollment, ...).
-- None of them has an auth.uid() guard — they all rely on never being
-- reachable by a client. Every call site in the app uses the service-role
-- client (verified: every `.rpc(` in app/ and lib/), and nothing in
-- components/ calls an RPC, so the revoke is behaviour-neutral for the app.
--
-- Left alone on purpose:
--   * is_admin() — referenced by RLS policy expressions, which are evaluated
--     as the invoking role, so `authenticated` genuinely needs EXECUTE.
--   * trigger functions — Postgres does not check EXECUTE when a trigger
--     fires, so revoking them is safe (and takes them off the RPC surface).
--
-- VERIFY (safe to run anytime; expect zero rows after this migration):
--   select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.prosecdef and p.proname <> 'is_admin'
--     and (has_function_privilege('anon', p.oid, 'execute')
--          or has_function_privilege('authenticated', p.oid, 'execute'));
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.prosecdef and p.proname <> 'is_admin'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;

-- 0012 revoked the PUBLIC default for future functions; this revokes the
-- direct anon/authenticated default as well, so the next SECURITY DEFINER
-- function someone adds doesn't ship client-callable.
alter default privileges in schema public revoke execute on functions from anon, authenticated;

-- Trigger functions can only run as triggers, but keep them off the
-- PostgREST RPC surface anyway.
revoke all on function public.enforce_api_key_limit() from public, anon, authenticated;
revoke all on function public.enforce_webhook_endpoint_limit() from public, anon, authenticated;

insert into public.schema_migrations (filename) values
  ('0042_api_integrations_hardening.sql')
on conflict do nothing;
