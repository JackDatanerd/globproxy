-- ============================================================
-- GLOBPROXY — FULL DATABASE SCHEMA
-- Run this entire file in Supabase SQL Editor (fresh project)
-- ============================================================

create extension if not exists "uuid-ossp";

-- ── PROFILES ─────────────────────────────────────────────────
create table public.profiles (
  id              uuid references auth.users on delete cascade primary key,
  email           text not null,
  full_name       text,
  role            text not null default 'user' check (role in ('user','reseller','admin')),
  company_name    text,
  is_suspended    boolean default false,
  suspension_reason text,
  suspended_at    timestamp with time zone,
  reseller_status text check (reseller_status in ('pending','approved','suspended','rejected')),
  is_deleted      boolean default false,
  deleted_at      timestamp with time zone,
  api_access      boolean default false,
  reseller_application jsonb,
  created_at      timestamp with time zone default now(),
  updated_at      timestamp with time zone default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ── BANDWIDTH ACCOUNTS ────────────────────────────────────────
create table public.bandwidth_accounts (
  id           uuid default uuid_generate_v4() primary key,
  user_id      uuid references public.profiles(id) on delete cascade not null unique,
  total_gb     numeric default 0,
  used_gb      numeric default 0, -- actual bytes consumed; cron usage-sync is the only writer
  allocated_gb numeric not null default 0, -- GB committed: reseller→client transfers (migration 0004) AND this account's own credentials (migration 0007)
  available_gb numeric generated always as (total_gb - allocated_gb) stored, -- NOT total_gb - used_gb - allocated_gb: allocated_gb already reserves a credential's full cap at creation, and used_gb (cron-synced) is always a subset of that reservation for active credentials — subtracting both double-counts. See migration 0009.
  alerted_80_at timestamp with time zone,
  alerted_95_at timestamp with time zone,
  created_at   timestamp with time zone default now(),
  updated_at   timestamp with time zone default now()
);

create or replace function public.handle_new_profile()
returns trigger language plpgsql security definer as $$
begin
  insert into public.bandwidth_accounts (user_id) values (new.id);
  return new;
end;
$$;

create trigger on_profile_created
  after insert on public.profiles
  for each row execute procedure public.handle_new_profile();

-- ── PLANS ─────────────────────────────────────────────────────
create table public.plans (
  id           uuid default uuid_generate_v4() primary key,
  name         text not null,
  slug         text unique not null,
  gb_amount    numeric not null,
  price_usd    numeric not null,
  price_per_gb numeric generated always as (price_usd / gb_amount) stored,
  is_reseller  boolean default false,
  is_active    boolean default true,
  created_at   timestamp with time zone default now()
);

insert into public.plans (name, slug, gb_amount, price_usd, is_reseller) values
  ('Micro',          'micro',          1,    4.50,  false),
  ('Starter',        'starter',        10,   35.00, false),
  ('Growth',         'growth',         100,  280.00, false),
  ('Scale',          'scale',          500,  1000.00, false),
  ('Reseller 100',   'reseller-100',   100,  280.00, true),
  ('Reseller 500',   'reseller-500',   500,  900.00, true);

-- ── ORDERS ────────────────────────────────────────────────────
create table public.orders (
  id                  uuid default uuid_generate_v4() primary key,
  user_id             uuid references public.profiles(id) on delete cascade not null,
  plan_id             uuid references public.plans(id),
  gb_amount           numeric not null,
  amount_usd          numeric not null,
  payment_method      text not null default 'paystack',
  payment_status      text not null default 'pending' check (payment_status in ('pending','paid','failed','refunded','cancelled')),
  paystack_reference  text,
  bandwidth_credited  boolean default false,
  created_at          timestamp with time zone default now(),
  paid_at             timestamp with time zone
);

-- ── PROXY CREDENTIALS ─────────────────────────────────────────
create table public.proxy_credentials (
  id                   uuid default uuid_generate_v4() primary key,
  user_id              uuid references public.profiles(id) on delete cascade not null,
  created_by           uuid references public.profiles(id),
  label                text,
  geonode_sub_user_id  text, -- Geonode's numeric sub-user ID; required for usage/delete calls, NOT geonode_username
  geonode_username     text,
  geonode_password     text,
  host                 text default 'proxy.globproxy.com', -- see migration 0013 — never default to the real Geonode hostname
  port                 integer default 9000,
  protocol             text default 'http' check (protocol in ('http','socks5')),
  sticky_duration      integer,
  endpoint_count       integer default 1,
  asn                  text, -- Geonode ASN/ISP targeting number, e.g. '13868'
  status               text not null default 'pending' check (status in ('pending','active','suspended')),
  gb_allocated         numeric not null default 0,
  gb_used              numeric default 0,
  country              text,
  state                text,
  city                 text,
  session_type         text default 'rotating' check (session_type in ('rotating','sticky')),
  activated_at         timestamp with time zone,
  created_at           timestamp with time zone default now()
);

-- ── RESELLER TRANSFERS ────────────────────────────────────────
create table public.reseller_transfers (
  id            uuid default uuid_generate_v4() primary key,
  reseller_id   uuid references public.profiles(id) not null,
  recipient_id  uuid references public.profiles(id) not null,
  credential_id uuid references public.proxy_credentials(id),
  gb_amount     numeric not null,
  status        text not null default 'pending' check (status in ('pending','active')),
  activated_at  timestamp with time zone,
  created_at    timestamp with time zone default now()
);

-- ── PLATFORM SETTINGS ─────────────────────────────────────────
create table public.platform_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamp with time zone default now()
);

insert into public.platform_settings (key, value) values
  ('auto_reload_enabled',    'false'),
  ('auto_reload_threshold_gb','10'),
  ('auto_reload_amount_gb',  '500'),
  ('geonode_stock',          '{"available_gb":0,"total_gb":0,"last_synced":null}')
on conflict (key) do nothing;

-- ── BANNED EMAILS ─────────────────────────────────────────────
create table public.banned_emails (
  id         uuid default uuid_generate_v4() primary key,
  email      text not null unique,
  reason     text,
  banned_at  timestamp with time zone default now(),
  banned_by  uuid references public.profiles(id)
);

-- ── HELPER FUNCTIONS ──────────────────────────────────────────
-- (reserve_reseller_gb was removed in migration 0008 — dead code,
-- superseded by allocate_reseller_bandwidth below.)

-- Atomic reseller-to-client bandwidth transfer. See migration 0004 for the
-- full rationale — this replaces a JS check-then-act read/write that raced
-- and wrote to the wrong column (used_gb instead of allocated_gb).
create or replace function public.allocate_reseller_bandwidth(
  p_reseller_id uuid,
  p_recipient_id uuid,
  p_gb numeric
)
returns table(new_reseller_allocated_gb numeric)
language plpgsql security definer as $$
declare
  v_updated_allocated numeric;
begin
  if p_gb is null or p_gb <= 0 then
    raise exception 'gb_allocated must be greater than 0';
  end if;
  if p_reseller_id = p_recipient_id then
    raise exception 'Cannot allocate bandwidth to yourself';
  end if;

  perform 1 from public.bandwidth_accounts where user_id = p_reseller_id for update;

  update public.bandwidth_accounts
  set allocated_gb = allocated_gb + p_gb
  where user_id = p_reseller_id
    and (total_gb - allocated_gb) >= p_gb
  returning allocated_gb into v_updated_allocated;

  if v_updated_allocated is null then
    raise exception 'Not enough bandwidth in your stock.' using errcode = 'P0001';
  end if;

  insert into public.bandwidth_accounts (user_id, total_gb, used_gb, allocated_gb)
  values (p_recipient_id, p_gb, 0, 0)
  on conflict (user_id) do update
    set total_gb = public.bandwidth_accounts.total_gb + excluded.total_gb;

  return query select v_updated_allocated;
end;
$$;

-- Atomic payment credit. See migration 0004 — replaces a JS read-then-write
-- that could lose a credit if two orders for the same user were paid at
-- nearly the same instant.
create or replace function public.credit_bandwidth(p_user_id uuid, p_gb numeric)
returns void language sql security definer as $$
  insert into public.bandwidth_accounts (user_id, total_gb, used_gb, allocated_gb)
  values (p_user_id, p_gb, 0, 0)
  on conflict (user_id) do update
    set total_gb = public.bandwidth_accounts.total_gb + excluded.total_gb;
$$;

-- Atomically claims an order (payment_status='paid', bandwidth_credited=true)
-- AND credits the GB in one transaction — see migration 0015. Previously
-- lib/bandwidth.ts did these as two separate calls: if the credit step
-- failed after the claim had already committed, the order was left
-- permanently "paid" with bandwidth_credited=true and nothing credited,
-- with no way for a retry to ever re-enter this path. Folding both into
-- one plpgsql function means an uncaught error in credit_bandwidth() below
-- rolls back the claim too, since both run in the same transaction.
create or replace function public.claim_and_credit_order(
  p_order_id uuid,
  p_user_id uuid,
  p_gb numeric,
  p_paystack_reference text
)
returns boolean
language plpgsql
security definer
as $$
declare
  v_claimed uuid;
begin
  update public.orders
  set payment_status     = 'paid',
      paystack_reference = p_paystack_reference,
      bandwidth_credited = true,
      paid_at            = now()
  where id = p_order_id
    and bandwidth_credited = false
  returning id into v_claimed;

  if v_claimed is null then
    return false; -- already credited by a concurrent/duplicate call
  end if;

  perform public.credit_bandwidth(p_user_id, p_gb); -- uncaught error here rolls back the claim above too

  return true;
end;
$$;

-- Reserve/release a credential's cap out of allocated_gb at creation/delete
-- time — see migration 0007/0009 for the full rationale (available_gb is
-- total_gb - allocated_gb; this is what keeps a burst of credential
-- creations from each passing a stale balance check). auth.uid() is null
-- for the service-role/admin client (trusted, app code gates those
-- callers); for the authenticated role calling this directly — which is
-- the legitimate path from app/api/dashboard/proxies' own session client —
-- the target account must be the caller's own. See migration 0012 for why
-- this check exists: security definer bypasses RLS, so without it any
-- logged-in user could pass someone else's user_id here directly.
create or replace function public.reserve_credential_bandwidth(p_user_id uuid, p_gb numeric)
returns void language plpgsql security definer as $$
declare
  v_updated numeric;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'Not authorized to reserve bandwidth for another account.' using errcode = '42501';
  end if;

  if p_gb is null or p_gb <= 0 then
    raise exception 'gb_allocated must be greater than 0';
  end if;

  update public.bandwidth_accounts
  set allocated_gb = allocated_gb + p_gb
  where user_id = p_user_id
    and (total_gb - allocated_gb) >= p_gb
  returning allocated_gb into v_updated;

  if v_updated is null then
    raise exception 'Insufficient bandwidth in your account.' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.release_credential_bandwidth(p_user_id uuid, p_gb numeric)
returns void language plpgsql security definer as $$
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'Not authorized to release bandwidth for another account.' using errcode = '42501';
  end if;

  if p_gb is null or p_gb <= 0 then
    return;
  end if;
  update public.bandwidth_accounts
  set allocated_gb = greatest(0, allocated_gb - p_gb)
  where user_id = p_user_id;
end;
$$;

-- Bulk usage-sync helpers — see migration 0010. Only ever called from
-- lib/usageSync.ts via the admin (service_role) client.
create or replace function public.bulk_update_credential_usage(updates jsonb)
returns void language plpgsql security definer as $$
begin
  update public.proxy_credentials pc
  set gb_used = (u->>'gb_used')::numeric
  from jsonb_array_elements(updates) as u
  where pc.id = (u->>'id')::uuid;
end;
$$;

create or replace function public.recalculate_bandwidth_accounts()
returns void language plpgsql security definer as $$
begin
  update public.bandwidth_accounts ba
  set used_gb = coalesce(sub.total, 0)
  from (
    select user_id, sum(gb_used) as total
    from public.proxy_credentials
    where status = 'active'
    group by user_id
  ) sub
  where ba.user_id = sub.user_id;

  update public.bandwidth_accounts ba
  set used_gb = 0
  where used_gb <> 0
    and not exists (
      select 1 from public.proxy_credentials pc
      where pc.user_id = ba.user_id and pc.status = 'active'
    );
end;
$$;

-- ── PROXY SESSIONS ────────────────────────────────────────────
-- Persisted, user-managed sticky sessions — see migration 0002.
create table public.proxy_sessions (
  id              uuid default uuid_generate_v4() primary key,
  credential_id   uuid references public.proxy_credentials(id) on delete cascade not null,
  user_id         uuid references public.profiles(id) on delete cascade not null,
  session_token   text not null,
  label           text not null default 'Session',
  pinned          boolean not null default false,
  collapsed       boolean not null default false,
  terminated_at   timestamp with time zone,
  created_at      timestamp with time zone default now()
);

create index proxy_sessions_credential_id_idx on public.proxy_sessions(credential_id);
create index proxy_sessions_user_id_idx on public.proxy_sessions(user_id);

alter table public.proxy_sessions enable row level security;

create policy "Users can view their own sessions"
  on public.proxy_sessions for select using (auth.uid() = user_id);
create policy "Users can create their own sessions"
  on public.proxy_sessions for insert with check (auth.uid() = user_id);
create policy "Users can update their own sessions"
  on public.proxy_sessions for update using (auth.uid() = user_id);
create policy "Users can delete their own sessions"
  on public.proxy_sessions for delete using (auth.uid() = user_id);

-- ── API KEYS ──────────────────────────────────────────────────
-- See migration 0005 — durable, hashed, revocable API keys.
create table public.api_keys (
  id           uuid default uuid_generate_v4() primary key,
  user_id      uuid references public.profiles(id) on delete cascade not null,
  key_hash     text not null unique,
  key_prefix   text not null,
  label        text not null default 'Default key',
  created_at   timestamp with time zone default now(),
  last_used_at timestamp with time zone,
  revoked_at   timestamp with time zone
);

create index api_keys_user_id_idx on public.api_keys(user_id);

alter table public.api_keys enable row level security;

create policy "Users can view own api keys"
  on public.api_keys for select using (auth.uid() = user_id);
create policy "Users can revoke own api keys"
  on public.api_keys for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id and revoked_at is not null);

-- ── ROW LEVEL SECURITY ────────────────────────────────────────
alter table public.profiles           enable row level security;
alter table public.bandwidth_accounts enable row level security;
alter table public.orders             enable row level security;
alter table public.proxy_credentials  enable row level security;
alter table public.reseller_transfers enable row level security;
alter table public.platform_settings  enable row level security;
alter table public.plans              enable row level security;
alter table public.banned_emails      enable row level security;

-- Profiles
create policy "Own profile" on public.profiles for select using (auth.uid() = id);
create policy "Update own profile" on public.profiles for update using (auth.uid() = id);

-- Lets a reseller see the profile (email/full_name) of a client they've
-- actually transferred bandwidth to — see migration 0014. Without this,
-- reseller_transfers' embedded `profiles` join returns null under RLS for
-- every recipient (since auth.uid() is the reseller, not the client),
-- which silently emptied /reseller/users, /reseller/earnings, and
-- /reseller/transfers.
create policy "Resellers can view own client profiles" on public.profiles for select
  using (
    exists (
      select 1 from public.reseller_transfers rt
      where rt.recipient_id = profiles.id and rt.reseller_id = auth.uid()
    )
  );

-- Admins can update any profile (needed for suspend/reinstate,
-- reseller approve/reject, API-access toggle done from the admin UI).
create policy "Admins can update any profile" on public.profiles for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

-- Prevents a non-admin from escalating their own row (role, is_suspended,
-- reseller_status, api_access, is_deleted) via a direct REST call, since
-- "Update own profile" above has no column restriction on its own.
create or replace function public.protect_privileged_profile_columns()
returns trigger language plpgsql security definer as $$
declare
  caller_is_admin boolean;
begin
  if auth.uid() is null then
    return new; -- service-role client; app code already gates this
  end if;

  select (role = 'admin') into caller_is_admin
  from public.profiles where id = auth.uid();

  if coalesce(caller_is_admin, false) then
    return new;
  end if;

  new.role                  := old.role;
  new.is_suspended          := old.is_suspended;
  new.suspended_at          := old.suspended_at;
  new.suspension_reason     := old.suspension_reason;
  new.reseller_status       := old.reseller_status;
  new.api_access            := old.api_access;
  new.is_deleted            := old.is_deleted;
  new.deleted_at            := old.deleted_at;
  new.email                 := old.email; -- see migration 0011 — the sync trigger below is how email changes actually land

  return new;
end;
$$;

create trigger protect_privileged_profile_columns
  before update on public.profiles
  for each row execute procedure public.protect_privileged_profile_columns();

-- Keeps profiles.email in sync with the real login email (auth.users.email)
-- after a user changes it through Supabase's normal email-change flow.
-- This is the ONLY path that's allowed to move profiles.email post-signup —
-- protect_privileged_profile_columns() above pins it for every other
-- caller. Runs with auth.uid() null (no request JWT attached to an
-- auth.users-triggered update), which is exactly the bypass condition that
-- function already grants to service-role/trigger writes. See migration
-- 0011 for the full rationale.
create or replace function public.sync_profile_email()
returns trigger language plpgsql security definer as $$
begin
  if new.email is distinct from old.email then
    update public.profiles set email = new.email, updated_at = now() where id = new.id;
  end if;
  return new;
end;
$$;

create trigger on_auth_user_email_updated
  after update of email on auth.users
  for each row execute procedure public.sync_profile_email();

-- Case-insensitive uniqueness — every lookup in this app that queries
-- profiles by email (signup dedupe, password reset, reseller/allocate's
-- recipient lookup) does .eq('email', x.toLowerCase()).single() and
-- assumes exactly one match.
-- PARTIAL index — see migration 0011. Every deleted account gets the literal
-- placeholder email '[deleted]', which is not a real collision; a plain
-- unique index would reject the second-ever account deletion.
create unique index if not exists profiles_email_unique_idx
  on public.profiles (lower(email))
  where email <> '[deleted]';

-- Bandwidth
create policy "Own bandwidth" on public.bandwidth_accounts for select using (auth.uid() = user_id);

-- Orders
create policy "Own orders" on public.orders for select using (auth.uid() = user_id);
create policy "Cancel own pending order" on public.orders for update
  using (auth.uid() = user_id and payment_status = 'pending')
  with check (auth.uid() = user_id and payment_status = 'cancelled');

-- RLS above only checks the FINAL payment_status — it doesn't stop a client
-- from also rewriting amount_usd/gb_amount/etc. on their own pending order
-- in the same update as long as payment_status ends up 'cancelled'. This
-- pins every other column to its previous value for non-admin callers, same
-- pattern as protect_privileged_profile_columns above. See migration 0006.
create or replace function public.protect_order_columns()
returns trigger language plpgsql security definer as $$
declare
  caller_is_admin boolean;
begin
  if auth.uid() is null then
    return new; -- service-role client (webhook, cron, activateBandwidth)
  end if;

  select (role = 'admin') into caller_is_admin
  from public.profiles where id = auth.uid();

  if coalesce(caller_is_admin, false) then
    return new;
  end if;

  new.user_id             := old.user_id;
  new.plan_id              := old.plan_id;
  new.gb_amount            := old.gb_amount;
  new.amount_usd           := old.amount_usd;
  new.payment_method       := old.payment_method;
  new.paystack_reference   := old.paystack_reference;
  new.bandwidth_credited   := old.bandwidth_credited;
  new.paid_at              := old.paid_at;
  new.created_at           := old.created_at;

  return new;
end;
$$;

create trigger protect_order_columns
  before update on public.orders
  for each row execute procedure public.protect_order_columns();

-- Credentials
create policy "Own or created credentials" on public.proxy_credentials for select
  using (auth.uid() = user_id or auth.uid() = created_by);
create policy "Create own credentials" on public.proxy_credentials for insert
  with check (auth.uid() = user_id and created_by is null);
create policy "Delete own unassigned credentials" on public.proxy_credentials for delete
  using (auth.uid() = user_id and created_by is null);

-- Transfers
create policy "Own transfers" on public.reseller_transfers for select
  using (auth.uid() = reseller_id or auth.uid() = recipient_id);

-- Plans - public read
create policy "Public plans" on public.plans for select using (true);

-- Settings - admin only
create policy "Admin settings" on public.platform_settings
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- Banned emails - admin read only
create policy "Admin can read banned emails" on public.banned_emails for select
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- ── LOCK DOWN RPC EXECUTE GRANTS ────────────────────────────────
-- See migration 0012 for the full rationale: every security-definer
-- function above bypasses RLS by design, and Postgres/Supabase both
-- default new functions to PUBLIC-executable unless explicitly revoked —
-- without this section, any authenticated user could call these directly
-- (e.g. credit_bandwidth to mint free bandwidth) regardless of the
-- ownership/role checks in application code. reserve_credential_bandwidth
-- and release_credential_bandwidth are genuinely called from the user's
-- own browser session (app/api/dashboard/proxies), so they keep
-- `authenticated`, backed by the auth.uid()-vs-p_user_id check inside each
-- function above; everything else is service_role only.
revoke all on function public.reserve_credential_bandwidth(uuid, numeric) from public;
grant execute on function public.reserve_credential_bandwidth(uuid, numeric) to authenticated, service_role;

revoke all on function public.release_credential_bandwidth(uuid, numeric) from public;
grant execute on function public.release_credential_bandwidth(uuid, numeric) to authenticated, service_role;

revoke all on function public.credit_bandwidth(uuid, numeric) from public;
grant execute on function public.credit_bandwidth(uuid, numeric) to service_role;

revoke all on function public.claim_and_credit_order(uuid, uuid, numeric, text) from public;
grant execute on function public.claim_and_credit_order(uuid, uuid, numeric, text) to service_role;

revoke all on function public.allocate_reseller_bandwidth(uuid, uuid, numeric) from public;
grant execute on function public.allocate_reseller_bandwidth(uuid, uuid, numeric) to service_role;

revoke all on function public.bulk_update_credential_usage(jsonb) from public;
grant execute on function public.bulk_update_credential_usage(jsonb) to service_role;

revoke all on function public.recalculate_bandwidth_accounts() from public;
grant execute on function public.recalculate_bandwidth_accounts() to service_role;

-- Any function created after this point defaults to service_role-only —
-- closes the gap for the next RPC function someone adds without thinking
-- about grants. Explicit opt-in required for authenticated/anon access.
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public grant execute on functions to service_role;
