-- ============================================================
-- 0054 — Public API & integrations close-out (audit section 6, pass 1)
-- ============================================================
-- Idempotent. Apply AFTER 0053. Old code keeps working between this
-- migration and the deploy (everything here is additive, except dropping the
-- browser-readable webhook-secret policy, which no app code used).

-- ── 1. api_keys: 'allocate' scope, expiry-warning marker, limit counts live keys only ──
-- 'allocate' is deliberately separate from 'write': it moves bandwidth between
-- accounts (money-equivalent), so a key that can create sub-users cannot
-- implicitly move stock. Enforced in lib/apiAuth.ts.
alter table public.api_keys drop constraint if exists api_keys_valid_scopes;
alter table public.api_keys
  add constraint api_keys_valid_scopes
  check (scopes <@ array['read','write','allocate']::text[] and cardinality(scopes) > 0);

alter table public.api_keys add column if not exists expiry_warned_at timestamptz;

-- The cap used to count expired-but-unrevoked keys, which the UI (and the
-- authenticator) already treat as dead: a user with 25 lapsed keys could not
-- create a new one.
create or replace function public.enforce_api_key_limit()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtext('api_keys:' || new.user_id::text));
  if (select count(*) from public.api_keys
      where user_id = new.user_id
        and revoked_at is null
        and (expires_at is null or expires_at > now())) >= 25 then
    raise exception 'Maximum of 25 active API keys per account' using errcode = '23514';
  end if;
  return new;
end;
$$;

-- ── 2. Mutating-request log (what did this key do?) ──────────────────
create table if not exists public.api_request_log (
  id          bigserial primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  key_id      uuid references public.api_keys(id) on delete set null,
  method      text not null,
  path        text not null,
  status      integer,
  ip          text,
  request_id  text,
  created_at  timestamptz not null default now()
);
create index if not exists api_request_log_user_idx on public.api_request_log (user_id, created_at desc);
create index if not exists api_request_log_key_idx  on public.api_request_log (key_id, created_at desc);
alter table public.api_request_log enable row level security;
-- No policies: service role only (read through /api/v1/account/activity and the dashboard route).

-- ── 3. Webhooks ──────────────────────────────────────────────────────
-- 3a. The signing secret must be "returned once". The 0018 select policy let
-- ANY logged-in browser session read every column — including `secret` — of
-- its own rows straight from PostgREST. Every app read goes through the
-- service role, so dropping the policy changes nothing for the app.
drop policy if exists "Users can view own webhook endpoints" on public.webhook_endpoints;

-- 3b. Rotation with a grace window: the previous secret keeps signing a second
-- header until it lapses.
alter table public.webhook_endpoints add column if not exists previous_secret            text;
alter table public.webhook_endpoints add column if not exists previous_secret_expires_at timestamptz;

-- 3c. Receiver response snippet for the delivery log.
alter table public.webhook_deliveries add column if not exists response_body text;

-- 3d. New events.
alter table public.webhook_endpoints drop constraint if exists webhook_endpoints_valid_events;
alter table public.webhook_endpoints
  add constraint webhook_endpoints_valid_events
  check (event_types <@ array[
    'session_created', 'session_activated', 'session_deleted', 'session_topped_up',
    'session_exhausted', 'session_suspended', 'session_resumed',
    'auto_topup_triggered', 'auto_topup_failed',
    'bandwidth_threshold_crossed', 'bandwidth_exhausted', 'bandwidth_credited',
    'bandwidth_allocated', 'bandwidth_reclaimed', 'bandwidth_refunded',
    'api_key_created', 'api_key_revoked', 'api_key_expiring'
  ]::text[]);

-- ── 4. Idempotent credential creation (no duplicate sub-users, ever) ─────
-- The idempotency table alone could not stop a stale-claim takeover from
-- creating a second credential when the first attempt had actually succeeded
-- but died before recording its response. A unique (user, key) on the
-- credential itself makes the create race-free: the loser rolls back its
-- reservation and upstream sub-user and returns the winner's row.
alter table public.proxy_credentials add column if not exists idempotency_key text;
create unique index if not exists proxy_credentials_idem_uidx
  on public.proxy_credentials (user_id, idempotency_key) where idempotency_key is not null;

-- ── 5. Grants for new objects (same posture as 0042) ───────────────────
revoke all on function public.enforce_api_key_limit() from public, anon, authenticated;

insert into public.schema_migrations (filename) values
  ('0054_api_integrations_closeout.sql')
on conflict do nothing;
