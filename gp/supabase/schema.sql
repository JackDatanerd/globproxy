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
  allocated_gb numeric not null default 0, -- GB a reseller has committed to clients (see migration 0004)
  available_gb numeric generated always as (total_gb - used_gb - allocated_gb) stored,
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
  host                 text default 'residential.geonode.com',
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
create or replace function public.reserve_reseller_gb(p_user_id uuid, p_gb numeric)
returns void language plpgsql security definer as $$
begin
  update public.bandwidth_accounts
  set used_gb = used_gb + p_gb
  where user_id = p_user_id;
end;
$$;

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
    and (total_gb - used_gb - allocated_gb) >= p_gb
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

  return new;
end;
$$;

create trigger protect_privileged_profile_columns
  before update on public.profiles
  for each row execute procedure public.protect_privileged_profile_columns();

-- Bandwidth
create policy "Own bandwidth" on public.bandwidth_accounts for select using (auth.uid() = user_id);

-- Orders
create policy "Own orders" on public.orders for select using (auth.uid() = user_id);
create policy "Cancel own pending order" on public.orders for update
  using (auth.uid() = user_id and payment_status = 'pending')
  with check (auth.uid() = user_id and payment_status = 'cancelled');

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
