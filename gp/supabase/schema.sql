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
  reseller_status text check (reseller_status in ('pending','approved','suspended')),
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
  used_gb      numeric default 0,
  available_gb numeric generated always as (total_gb - used_gb) stored,
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
  payment_status      text not null default 'pending' check (payment_status in ('pending','paid','failed','refunded')),
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

-- ── HELPER FUNCTIONS ──────────────────────────────────────────
create or replace function public.reserve_reseller_gb(p_user_id uuid, p_gb numeric)
returns void language plpgsql security definer as $$
begin
  update public.bandwidth_accounts
  set used_gb = used_gb + p_gb
  where user_id = p_user_id;
end;
$$;

-- ── ROW LEVEL SECURITY ────────────────────────────────────────
alter table public.profiles           enable row level security;
alter table public.bandwidth_accounts enable row level security;
alter table public.orders             enable row level security;
alter table public.proxy_credentials  enable row level security;
alter table public.reseller_transfers enable row level security;
alter table public.platform_settings  enable row level security;
alter table public.plans              enable row level security;

-- Profiles
create policy "Own profile" on public.profiles for select using (auth.uid() = id);
create policy "Update own profile" on public.profiles for update using (auth.uid() = id);

-- Bandwidth
create policy "Own bandwidth" on public.bandwidth_accounts for select using (auth.uid() = user_id);

-- Orders
create policy "Own orders" on public.orders for select using (auth.uid() = user_id);

-- Credentials
create policy "Own or created credentials" on public.proxy_credentials for select
  using (auth.uid() = user_id or auth.uid() = created_by);

-- Transfers
create policy "Own transfers" on public.reseller_transfers for select
  using (auth.uid() = reseller_id or auth.uid() = recipient_id);

-- Plans - public read
create policy "Public plans" on public.plans for select using (true);

-- Settings - admin only
create policy "Admin settings" on public.platform_settings
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
