-- ============================================================
-- GLOBPROXY — FULL DATABASE SCHEMA
-- Run this entire file in Supabase SQL Editor (fresh project)
-- ============================================================
--
-- INCLUDES MIGRATIONS THROUGH: 0033_seed_benchmark_credential_setting.sql
--
-- This line is the source of truth `scripts/check-schema-sync.mjs` reads
-- to compare against supabase/migrations/ — it's what CI checks on every
-- push (see .github/workflows/schema-drift-check.yml). It exists because
-- this file has drifted from the migrations folder before: this schema
-- was "regenerated through 0022" in one commit, then 0023 landed in the
-- very next commit without this file being touched, silently reopening
-- the RLS gap 0023 existed to close. A human remembering to regen this
-- file is not a control; a CI check that fails the build when the two
-- are out of sync is. When you add a migration, update the line above
-- to match, or the schema-drift-check job will fail your push.
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
  -- API access application — see migration 0028. Same pending/approved/
  -- rejected shape as reseller_status/reseller_application above, just
  -- for the separate "can this reseller call the v1 API" capability.
  api_access_status text check (api_access_status is null or api_access_status in ('pending','approved','rejected')),
  api_access_application jsonb,
  -- Denormalized from mfa_totp_factors so middleware's existing single
  -- profile fetch (role, is_suspended) can add this to the same query
  -- instead of a second round trip on every protected request. Kept in
  -- sync exclusively by lib/mfa.ts. See migration 0020.
  mfa_enabled     boolean not null default false,
  -- Referral code + affiliate program — see migration 0031. Every profile
  -- gets a referral_code for free (the default calls
  -- generate_unique_referral_code(), defined further down, once that
  -- function exists — see the note at its definition for why this
  -- column's default is set via ALTER TABLE after the function, not
  -- inline here). affiliate_status/application follow the exact same
  -- pending/approved/rejected shape as reseller_status/api_access_status
  -- above; affiliate_commission_rate(_lifetime) are per-affiliate rates
  -- an admin sets at approval time.
  referral_code   text unique,
  affiliate_status text check (affiliate_status is null or affiliate_status in ('pending','approved','rejected','suspended')),
  affiliate_application jsonb,
  affiliate_commission_rate numeric check (affiliate_commission_rate is null or (affiliate_commission_rate >= 0 and affiliate_commission_rate <= 1)),
  affiliate_commission_rate_lifetime numeric check (affiliate_commission_rate_lifetime is null or (affiliate_commission_rate_lifetime >= 0 and affiliate_commission_rate_lifetime <= 1)),
  created_at      timestamp with time zone default now(),
  updated_at      timestamp with time zone default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
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
  archived_used_gb numeric not null default 0, -- Durable ledger for GB consumed by credentials that have since been deleted — used_gb (live sum over *active* credentials) would otherwise silently lose this the moment the row disappears. See migration 0025.
  alerted_80_at timestamp with time zone,
  alerted_95_at timestamp with time zone,
  -- Account-level default that a new session's auto-allocate section
  -- pre-fills from (still overridable per session before submit) — set
  -- once via set_default_auto_topup() instead of typing it in on every
  -- session. Deliberately never applied retroactively to existing
  -- sessions. See migration 0019.
  default_auto_topup_enabled boolean not null default false,
  default_auto_topup_threshold_gb numeric,
  default_auto_topup_amount_gb numeric,
  created_at   timestamp with time zone default now(),
  updated_at   timestamp with time zone default now(),
  constraint bwacct_default_auto_topup_threshold_nonneg
    check (default_auto_topup_threshold_gb is null or default_auto_topup_threshold_gb >= 0),
  constraint bwacct_default_auto_topup_amount_positive
    check (default_auto_topup_amount_gb is null or default_auto_topup_amount_gb > 0),
  constraint bwacct_default_auto_topup_requires_config
    check (
      not default_auto_topup_enabled
      or (default_auto_topup_threshold_gb is not null and default_auto_topup_amount_gb is not null)
    )
);

create or replace function public.handle_new_profile()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
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
  paid_at             timestamp with time zone,
  -- Assigned exactly once, atomically, inside claim_and_credit_order()
  -- below when an order is claimed as paid — never at order-creation, so
  -- a pending/cancelled/failed order never has one. See migration 0021.
  invoice_number      text unique
);

-- ── REFERRALS & AFFILIATE COMMISSIONS ────────────────────────────
-- See migration 0031 for the full design rationale. Two reward
-- mechanisms sharing one attribution table (referrals): a free-for-
-- everyone one-time GB bonus on a referred user's first paid order, and
-- a per-order cash commission for admin-approved affiliates, decided at
-- credit-time by the referrer's profiles.affiliate_status rather than
-- fixed on the referral row itself.

create or replace function public.generate_unique_referral_code()
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_code text;
  v_exists boolean;
begin
  loop
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    select exists(select 1 from public.profiles where referral_code = v_code) into v_exists;
    exit when not v_exists;
  end loop;
  return v_code;
end;
$$;

-- profiles.referral_code (declared above, nullable at CREATE TABLE time
-- since this function didn't exist yet) gets its default wired up here,
-- once the function it calls actually exists. A fresh bootstrap via this
-- file has no existing rows to backfill (unlike migration 0031, which
-- loops over live data) — every profile created from here on gets a code
-- for free via this default.
alter table public.profiles alter column referral_code set default public.generate_unique_referral_code();
alter table public.profiles alter column referral_code set not null;

create table public.referrals (
  id                    uuid default uuid_generate_v4() primary key,
  referrer_id           uuid references public.profiles(id) on delete cascade not null,
  referred_user_id      uuid references public.profiles(id) on delete cascade not null unique,
  code_used             text not null,
  created_at            timestamp with time zone default now(),
  gb_bonus_credited_at  timestamp with time zone,
  gb_bonus_amount       numeric,
  constraint referrals_no_self_referral check (referrer_id <> referred_user_id)
);

create index if not exists idx_referrals_referrer on public.referrals(referrer_id);

create table public.affiliate_commissions (
  id                     uuid default uuid_generate_v4() primary key,
  referral_id            uuid references public.referrals(id) on delete cascade not null,
  referrer_id            uuid references public.profiles(id) on delete cascade not null,
  referred_user_id       uuid references public.profiles(id) on delete cascade not null,
  order_id               uuid references public.orders(id) on delete cascade not null unique,
  gross_amount_usd       numeric not null,
  commission_rate        numeric not null,
  commission_amount_usd  numeric not null,
  status                 text not null default 'pending' check (status in ('pending','paid','void')),
  created_at             timestamp with time zone default now(),
  paid_at                timestamp with time zone
);

create index if not exists idx_affiliate_commissions_referrer on public.affiliate_commissions(referrer_id);
create index if not exists idx_affiliate_commissions_status on public.affiliate_commissions(status);

create or replace function public.record_referral_signup(p_code text, p_new_user_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_referrer_id uuid;
begin
  if p_code is null or p_new_user_id is null then
    return;
  end if;

  select id into v_referrer_id from public.profiles where referral_code = upper(trim(p_code));

  if v_referrer_id is null or v_referrer_id = p_new_user_id then
    return; -- unknown code, or (defensively) a self-referral
  end if;

  insert into public.referrals (referrer_id, referred_user_id, code_used)
  values (v_referrer_id, p_new_user_id, upper(trim(p_code)))
  on conflict (referred_user_id) do nothing;
end;
$$;

create or replace function public.credit_referral_bonus(p_referral_id uuid, p_gb numeric)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_referrer_id uuid;
  v_referred_id uuid;
  v_claimed uuid;
begin
  update public.referrals
  set gb_bonus_credited_at = now(), gb_bonus_amount = p_gb
  where id = p_referral_id and gb_bonus_credited_at is null
  returning id, referrer_id, referred_user_id into v_claimed, v_referrer_id, v_referred_id;

  if v_claimed is null then
    return false;
  end if;

  perform public.credit_bandwidth(v_referrer_id, p_gb);
  perform public.credit_bandwidth(v_referred_id, p_gb);

  return true;
end;
$$;

-- Intro rate applies for AFFILIATE_INTRO_WINDOW_DAYS (90, kept in sync
-- with the same constant in lib/referralConfig.ts) after the referral
-- was created; lifetime rate after. Defaults (30%/15%) only apply if an
-- approved affiliate somehow has neither rate set on their profile.
create or replace function public.record_affiliate_commission(
  p_referral_id uuid,
  p_order_id uuid,
  p_gross_amount numeric
)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_referrer_id uuid;
  v_referred_id uuid;
  v_created_at timestamptz;
  v_affiliate_status text;
  v_intro_rate numeric;
  v_lifetime_rate numeric;
  v_rate numeric;
begin
  select referrer_id, referred_user_id, created_at
    into v_referrer_id, v_referred_id, v_created_at
  from public.referrals where id = p_referral_id;

  if v_referrer_id is null then
    return;
  end if;

  select affiliate_status,
         coalesce(affiliate_commission_rate, 0.30),
         coalesce(affiliate_commission_rate_lifetime, 0.15)
    into v_affiliate_status, v_intro_rate, v_lifetime_rate
  from public.profiles where id = v_referrer_id;

  if v_affiliate_status is distinct from 'approved' then
    return;
  end if;

  v_rate := case when now() <= v_created_at + interval '90 days' then v_intro_rate else v_lifetime_rate end;

  insert into public.affiliate_commissions
    (referral_id, referrer_id, referred_user_id, order_id, gross_amount_usd, commission_rate, commission_amount_usd)
  values
    (p_referral_id, v_referrer_id, v_referred_id, p_order_id, p_gross_amount, v_rate, round(p_gross_amount * v_rate, 2))
  on conflict (order_id) do nothing;
end;
$$;

-- ── NETWORK BENCHMARKS (public /status page) ─────────────────────
-- See migration 0032. RLS below is deliberately public-select — this
-- backs an unauthenticated page.
create table public.network_benchmarks (
  id             uuid default uuid_generate_v4() primary key,
  target_label   text not null,
  success_rate   numeric not null check (success_rate >= 0 and success_rate <= 100),
  avg_latency_ms numeric,
  sample_size    integer not null default 0 check (sample_size >= 0),
  measured_at    timestamp with time zone not null default now(),
  notes          text,
  created_at     timestamp with time zone not null default now()
);

create index if not exists idx_network_benchmarks_target_measured
  on public.network_benchmarks(target_label, measured_at desc);

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
  created_at           timestamp with time zone default now(),
  -- Lets a credential top itself up automatically once its remaining GB
  -- drops to a threshold, by an amount, using the account's existing
  -- balance — via topup_credential(), the same RPC the manual top-up
  -- button calls. See migration 0017.
  auto_topup_enabled   boolean not null default false,
  auto_topup_threshold_gb numeric,
  auto_topup_amount_gb numeric,
  auto_topup_last_triggered_at timestamptz,
  -- Set when an auto-topup attempt fails for insufficient account balance,
  -- so lib/autoTopup.ts can alert once and go quiet rather than re-sending
  -- the same email every ~5 minutes on every subsequent cron tick.
  auto_topup_insufficient_alerted_at timestamptz,
  constraint auto_topup_threshold_nonneg
    check (auto_topup_threshold_gb is null or auto_topup_threshold_gb >= 0),
  constraint auto_topup_amount_positive
    check (auto_topup_amount_gb is null or auto_topup_amount_gb > 0),
  constraint auto_topup_requires_config
    check (
      not auto_topup_enabled
      or (auto_topup_threshold_gb is not null and auto_topup_amount_gb is not null)
    )
);

-- Partial index — the cron scan (lib/autoTopup.ts) filters on this, and
-- almost every row will have it false, so a full index would carry a lot
-- of dead weight for a query that only ever wants the true rows.
create index proxy_credentials_auto_topup_idx
  on public.proxy_credentials (auto_topup_enabled)
  where auto_topup_enabled = true;

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
  ('geonode_stock',          '{"available_gb":0,"total_gb":0,"last_synced":null}'),
  ('benchmark_credential_id', '')
on conflict (key) do nothing;

-- usage_last_synced_at / usage_sync_stale_alerted_at are written by
-- lib/usageSync.ts and app/api/cron/[task]/route.ts's checkUsageSyncFreshness()
-- (the usage-sync watchdog) — no seed row needed, upsert creates them on
-- first write. Documented here only so schema.sql stays a complete picture
-- of platform_settings keys in use.

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
language plpgsql security definer set search_path = public, pg_temp
as $$
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
returns void language sql security definer set search_path = public, pg_temp
as $$
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
--
-- invoice_number is assigned in this same atomic claim (migration 0021) —
-- the one place an order transitions to paid, so it's also the one place
-- an invoice number can be generated without racing a concurrent
-- webhook + verify-payment call.
create sequence if not exists public.invoice_number_seq;

create or replace function public.claim_and_credit_order(
  p_order_id uuid,
  p_user_id uuid,
  p_gb numeric,
  p_paystack_reference text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claimed uuid;
begin
  update public.orders
  set payment_status     = 'paid',
      paystack_reference = p_paystack_reference,
      bandwidth_credited = true,
      paid_at             = now(),
      invoice_number      = 'INV-' || to_char(now(), 'YYYY')
                             || '-' || lpad(nextval('public.invoice_number_seq')::text, 6, '0')
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
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
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
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
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

-- Atomic credential top-up — see migration 0016 for full rationale.
-- service_role-only; the calling route (dashboard/proxies/[id]/topup)
-- verifies the caller's own session before ever reaching this.
create or replace function public.topup_credential(
  p_credential_id uuid,
  p_user_id uuid,
  p_gb numeric
)
returns numeric language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_created_by uuid;
  v_new_total numeric;
  v_reserved numeric;
begin
  if p_gb is null or p_gb <= 0 then
    raise exception 'Top-up amount must be greater than 0';
  end if;

  select status, created_by into v_status, v_created_by
  from public.proxy_credentials
  where id = p_credential_id and user_id = p_user_id
  for update;

  if not found then
    raise exception 'Credential not found' using errcode = 'P0002';
  end if;

  if v_created_by is not null then
    raise exception 'This credential was allocated by your reseller and cannot be topped up directly. Contact them.';
  end if;

  if v_status not in ('active', 'pending') then
    raise exception 'Only active or pending credentials can be topped up.';
  end if;

  update public.bandwidth_accounts
  set allocated_gb = allocated_gb + p_gb
  where user_id = p_user_id
    and (total_gb - allocated_gb) >= p_gb
  returning allocated_gb into v_reserved;

  if v_reserved is null then
    raise exception 'Insufficient bandwidth in your account.' using errcode = 'P0001';
  end if;

  update public.proxy_credentials
  set gb_allocated = gb_allocated + p_gb
  where id = p_credential_id
  returning gb_allocated into v_new_total;

  return v_new_total;
end;
$$;

-- Lets a user (or admin, via the same dashboard route later if ever
-- needed) turn auto-topup on/off and set its threshold/amount for a
-- credential they own. Mirrors topup_credential() above's ownership
-- model exactly: created_by must be null (self-owned — a
-- reseller-allocated credential is the reseller's commitment to the
-- client, not the client's own balance to configure draws against), and
-- status must be 'active' or 'pending'. Reuses topup_credential() as the
-- actual top-up mechanism rather than duplicating its atomic
-- reserve+bump logic — the cron-driven auto-topup path and the
-- user-initiated manual top-up button call the exact same RPC. See
-- migration 0017.
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

-- Account-level counterpart to set_auto_topup() above — see migration
-- 0019. bandwidth_accounts has select-own RLS only ("Own bandwidth"
-- below), no update policy, same reasoning as proxy_credentials: writes
-- go through a service_role RPC that validates the input, not direct
-- client writes.
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

-- Bulk usage-sync helpers — see migration 0010. Only ever called from
-- lib/usageSync.ts via the admin (service_role) client.
create or replace function public.bulk_update_credential_usage(updates jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  update public.proxy_credentials pc
  set gb_used = (u->>'gb_used')::numeric
  from jsonb_array_elements(updates) as u
  where pc.id = (u->>'id')::uuid;
end;
$$;

create or replace function public.recalculate_bandwidth_accounts()
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  update public.bandwidth_accounts ba
  set used_gb = coalesce(sub.total, 0) + ba.archived_used_gb
  from (
    select user_id, sum(gb_used) as total
    from public.proxy_credentials
    where status = 'active'
    group by user_id
  ) sub
  where ba.user_id = sub.user_id;

  update public.bandwidth_accounts ba
  set used_gb = archived_used_gb
  where used_gb <> archived_used_gb
    and not exists (
      select 1 from public.proxy_credentials pc
      where pc.user_id = ba.user_id and pc.status = 'active'
    );
end;
$$;

-- Bump the archive by exactly what a credential had consumed, at the
-- moment it's deleted — see migration 0025. Called from the same request
-- that releases the credential's unused allocation, so both numbers come
-- from the same usedGb snapshot and can't drift apart.
create or replace function public.archive_credential_used_gb(p_user_id uuid, p_gb numeric)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if p_gb is null or p_gb <= 0 then
    return;
  end if;
  update public.bandwidth_accounts
  set archived_used_gb = archived_used_gb + p_gb
  where user_id = p_user_id;
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
  on public.proxy_sessions for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.proxy_credentials pc
      where pc.id = credential_id and pc.user_id = auth.uid()
    )
  );
create policy "Users can update their own sessions"
  on public.proxy_sessions for update
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.proxy_credentials pc
      where pc.id = credential_id and pc.user_id = auth.uid()
    )
  );
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

-- ── WEBHOOK ENDPOINTS ─────────────────────────────────────────
-- See migration 0018. Two events for v1: 'session_created' and
-- 'bandwidth_threshold_crossed'.
--
-- The signing secret (secret) is stored in plaintext, unlike
-- api_keys.key_hash above — deliberate, not an oversight: an API key is
-- only ever compared against an incoming attempt, so a one-way hash
-- works; a webhook secret has to be read back in full at send time to
-- compute the outgoing HMAC signature. Protected the same way api_keys
-- is instead: RLS restricts it to select-by-owner only, and no
-- application code ever returns it in a list response after creation —
-- only the create response includes it, once.
create table public.webhook_endpoints (
  id               uuid default uuid_generate_v4() primary key,
  user_id          uuid references public.profiles(id) on delete cascade not null,
  url              text not null,
  secret           text not null,
  event_types      text[] not null default '{}',
  enabled          boolean not null default true,
  created_at       timestamptz not null default now(),
  last_success_at  timestamptz,
  last_failure_at  timestamptz,
  last_error       text,
  constraint webhook_endpoints_https_only check (url ~* '^https://'),
  -- Defense-in-depth alongside the app-layer check in the API routes —
  -- even a bug in application code can't get an unrecognized event type
  -- persisted here.
  constraint webhook_endpoints_valid_events
    check (event_types <@ array['session_created', 'bandwidth_threshold_crossed']::text[])
);

create index webhook_endpoints_user_id_idx on public.webhook_endpoints(user_id);
-- Lets dispatchWebhook() find "who's subscribed to event X" directly via
-- the `.contains()` query instead of loading every endpoint and filtering
-- in application code.
create index webhook_endpoints_event_types_idx
  on public.webhook_endpoints using gin(event_types);

alter table public.webhook_endpoints enable row level security;

create policy "Users can view own webhook endpoints"
  on public.webhook_endpoints for select
  using (auth.uid() = user_id);

-- Deliberately no client insert/update/delete policy, same reasoning as
-- api_keys above: creating one requires generating the secret
-- server-side, and every mutation — including just editing the URL or
-- flipping enabled — needs to re-run the SSRF guard (lib/ssrfGuard.ts)
-- against the URL, which RLS has no way to do. All writes go through
-- /api/dashboard/webhooks/* using the service role after an explicit
-- ownership check.

-- ── TWO-FACTOR AUTHENTICATION (MFA) ───────────────────────────
-- See migration 0020. Mandatory for admin and reseller roles (enforced
-- in application code — middleware.ts + the three protected layouts —
-- not here; this section only lays down the storage). Optional and
-- available to any user.
--
-- Three tables:
--   mfa_totp_factors      — one row per user, the authenticator-app secret
--   mfa_backup_codes      — one-time recovery codes, hashed like api_keys
--   mfa_verified_sessions — short-lived "this browser session completed
--                           its second factor" tokens. Supabase's own
--                           session (the JWT in the cookie) has no concept
--                           of our custom TOTP step-up, so this is a
--                           second, independent proof-of-recent-MFA that
--                           middleware checks on every protected request
--                           for admin/reseller accounts.
--
-- All three are RLS-enabled with NO client policies at all — every access
-- path goes through server routes using the service-role admin client
-- with an explicit, code-level user_id check (see lib/mfa.ts), the same
-- "no direct client access, ever" posture migration 0012 pushed the
-- money-moving RPCs toward. A TOTP secret or a backup-code hash has no
-- legitimate reason to ever be readable via a client-side supabase.from()
-- call, unlike api_keys which deliberately lets an owner list their own
-- key hashes/prefixes.
create table public.mfa_totp_factors (
  user_id        uuid primary key references public.profiles(id) on delete cascade,
  secret         text not null,          -- base32 TOTP secret. Shown to the user once, at enrollment, then never again.
  confirmed      boolean not null default false,
  failed_attempts integer not null default 0,
  locked_until   timestamptz,            -- brute-force lockout after MAX_FAILED_ATTEMPTS (lib/mfa.ts)
  created_at     timestamptz not null default now(),
  confirmed_at   timestamptz,
  last_used_at   timestamptz,
  -- Absolute 30-second period index of the last successfully-consumed
  -- TOTP code (see lib/mfa.ts's validateTotpOnce()). Any code whose own
  -- period counter is <= this value is rejected as a replay, regardless
  -- of whether it's otherwise numerically correct — otpauth's
  -- TOTP.validate() only checks correctness within a window, not
  -- whether that exact code was already accepted once already. See
  -- migration 0022.
  last_used_counter bigint
);

alter table public.mfa_totp_factors enable row level security;

create table public.mfa_backup_codes (
  id          uuid default uuid_generate_v4() primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  code_hash   text not null,   -- sha-256 hex digest of the plaintext code; plaintext is shown once at generation and never stored
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index mfa_backup_codes_user_id_idx on public.mfa_backup_codes(user_id);
-- Fast "does this user have unused codes left" / lookup-by-hash path —
-- both the settings page count and consumeBackupCode() filter on this.
create index mfa_backup_codes_unused_idx on public.mfa_backup_codes(user_id) where used_at is null;
create unique index mfa_backup_codes_hash_idx on public.mfa_backup_codes(code_hash);

alter table public.mfa_backup_codes enable row level security;

create table public.mfa_verified_sessions (
  token_hash  text primary key,   -- sha-256 hex digest of the opaque cookie value
  user_id     uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

create index mfa_verified_sessions_user_id_idx on public.mfa_verified_sessions(user_id);
-- Middleware's hot-path lookup is by token_hash (the primary key) alone;
-- this second index just makes "revoke everything for this user" (used on
-- disable/reset) and the cron sweep in the helper functions above cheap too.
create index mfa_verified_sessions_expires_idx on public.mfa_verified_sessions(expires_at);

alter table public.mfa_verified_sessions enable row level security;

-- Cron cleanup for mfa_verified_sessions — mirrors the existing
-- app/api/cron/[task]/route.ts task registry pattern. Expired rows are
-- already functionally inert (any lookup filters expires_at > now()),
-- this just keeps the table from growing unbounded on a long-lived
-- deployment. See migration 0020.
create or replace function public.cleanup_expired_mfa_sessions()
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from public.mfa_verified_sessions where expires_at < now();
$$;

-- Atomic MFA teardown, used by both self-service disable and admin
-- reset (lib/mfa.ts wipeMfa()). Runs as one transaction so a failure
-- partway through can't leave mfa_enabled=true with no confirmed
-- factor to verify against — see migration 0024 for the full incident
-- writeup of what that desync looked like in practice.
create or replace function public.wipe_mfa(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.mfa_totp_factors where user_id = p_user_id;
  delete from public.mfa_backup_codes where user_id = p_user_id;
  delete from public.mfa_verified_sessions where user_id = p_user_id;
  update public.profiles set mfa_enabled = false where id = p_user_id;
end;
$$;

revoke all on function public.wipe_mfa(uuid) from public;
grant execute on function public.wipe_mfa(uuid) to service_role;

-- Atomic MFA enrollment confirmation — see migration 0026. Mirrors
-- wipe_mfa above for the opposite direction: confirming a factor and
-- marking the account mfa_enabled must commit together or not at all,
-- same reasoning as every other "two related writes, one real state"
-- RPC in this file (claim_and_credit_order, topup_credential, etc).
create or replace function public.confirm_totp_enrollment(
  p_user_id uuid,
  p_used_counter integer
)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_updated uuid;
begin
  update public.mfa_totp_factors
  set confirmed = true,
      confirmed_at = now(),
      failed_attempts = 0,
      locked_until = null,
      last_used_at = now(),
      last_used_counter = p_used_counter
  where user_id = p_user_id
  returning user_id into v_updated;

  if v_updated is null then
    raise exception 'No pending MFA enrollment found for this account.' using errcode = 'P0002';
  end if;

  update public.profiles set mfa_enabled = true where id = p_user_id;
end;
$$;

revoke all on function public.confirm_totp_enrollment(uuid, integer) from public;
grant execute on function public.confirm_totp_enrollment(uuid, integer) to service_role;

-- ── ROW LEVEL SECURITY ────────────────────────────────────────
alter table public.profiles           enable row level security;
alter table public.bandwidth_accounts enable row level security;
alter table public.orders             enable row level security;
alter table public.proxy_credentials  enable row level security;
alter table public.reseller_transfers enable row level security;
alter table public.platform_settings  enable row level security;
alter table public.plans              enable row level security;
alter table public.banned_emails      enable row level security;
alter table public.referrals             enable row level security;
alter table public.affiliate_commissions enable row level security;
alter table public.network_benchmarks    enable row level security;

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

-- Admin check lives in a SECURITY DEFINER function rather than an inline
-- subquery on profiles. A profiles policy that subqueries profiles is the
-- textbook trigger for "infinite recursion detected in policy for
-- relation 'profiles'" — Postgres has to resolve profiles' own RLS to
-- answer the inner SELECT, which is exactly what this policy is trying to
-- answer in the first place. SECURITY DEFINER functions run as their
-- owner (postgres), which bypasses RLS, breaking the cycle. See migration
-- 0029 — this bug fired on every profile UPDATE, not just admin ones,
-- since all permissive policies on the command are evaluated together.
create or replace function public.is_admin(check_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = check_uid and role = 'admin'
  );
$$;

revoke all on function public.is_admin(uuid) from public, anon, authenticated;
grant execute on function public.is_admin(uuid) to authenticated;

-- Admins can update any profile (needed for suspend/reinstate,
-- reseller approve/reject, API-access toggle done from the admin UI).
create policy "Admins can update any profile" on public.profiles for update
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- Lets app/api/auth/signup check whether an email already has an
-- auth.users identity, independent of profiles.email — which account
-- deletion (app/api/user/delete-account, app/api/admin/delete-user)
-- deliberately overwrites with the literal '[deleted]' placeholder.
-- Without this, signup's dedupe check silently stopped detecting
-- previously-deleted accounts' real addresses and re-invoked
-- supabase.auth.signUp() against an auth.users row that still exists
-- (banned, not hard-deleted). See migration 0029.
create or replace function public.auth_email_exists(check_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from auth.users where lower(email) = lower(check_email)
  );
$$;

-- No grant to anon/authenticated — only called server-side via the
-- service-role admin client in app/api/auth/signup/route.ts, same trust
-- boundary as the banned_emails/profiles lookups already there.
revoke all on function public.auth_email_exists(text) from public, anon, authenticated;

-- Prevents a non-admin from escalating their own row (role, is_suspended,
-- reseller_status, api_access, is_deleted) via a direct REST call, since
-- "Update own profile" above has no column restriction on its own.
create or replace function public.protect_privileged_profile_columns()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return new; -- service-role client; app code already gates this
  end if;

  if public.is_admin(auth.uid()) then
    return new;
  end if;

  new.role                               := old.role;
  new.is_suspended                       := old.is_suspended;
  new.suspended_at                       := old.suspended_at;
  new.suspension_reason                  := old.suspension_reason;
  new.reseller_status                    := old.reseller_status;
  new.api_access                         := old.api_access;
  new.api_access_status                  := old.api_access_status;
  new.is_deleted                         := old.is_deleted;
  new.deleted_at                         := old.deleted_at;
  new.email                              := old.email; -- see migration 0011 — the sync trigger below is how email changes actually land
  new.affiliate_status                   := old.affiliate_status; -- see migration 0031
  new.affiliate_commission_rate          := old.affiliate_commission_rate;
  new.affiliate_commission_rate_lifetime := old.affiliate_commission_rate_lifetime;

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
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
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
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
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
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- Banned emails - admin read only
create policy "Admin can read banned emails" on public.banned_emails for select
  using (public.is_admin(auth.uid()));

-- Referrals / affiliate commissions / network benchmarks — see migrations 0031, 0032
create policy "Referrer can view own referrals" on public.referrals for select
  using (auth.uid() = referrer_id);
create policy "Admins can view all referrals" on public.referrals for select
  using (public.is_admin(auth.uid()));

create policy "Referrer can view own commissions" on public.affiliate_commissions for select
  using (auth.uid() = referrer_id);
create policy "Admins can view all commissions" on public.affiliate_commissions for select
  using (public.is_admin(auth.uid()));

-- Network benchmarks - public read (backs the unauthenticated /status page)
create policy "Anyone can view benchmarks" on public.network_benchmarks for select
  using (true);

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

revoke all on function public.generate_unique_referral_code() from public;
grant execute on function public.generate_unique_referral_code() to service_role, authenticated;

revoke all on function public.record_referral_signup(text, uuid) from public;
grant execute on function public.record_referral_signup(text, uuid) to service_role;

revoke all on function public.credit_referral_bonus(uuid, numeric) from public;
grant execute on function public.credit_referral_bonus(uuid, numeric) to service_role;

revoke all on function public.record_affiliate_commission(uuid, uuid, numeric) from public;
grant execute on function public.record_affiliate_commission(uuid, uuid, numeric) to service_role;

revoke all on function public.claim_and_credit_order(uuid, uuid, numeric, text) from public;
grant execute on function public.claim_and_credit_order(uuid, uuid, numeric, text) to service_role;

revoke all on function public.allocate_reseller_bandwidth(uuid, uuid, numeric) from public;
grant execute on function public.allocate_reseller_bandwidth(uuid, uuid, numeric) to service_role;

revoke all on function public.bulk_update_credential_usage(jsonb) from public;
grant execute on function public.bulk_update_credential_usage(jsonb) to service_role;

revoke all on function public.recalculate_bandwidth_accounts() from public;
grant execute on function public.recalculate_bandwidth_accounts() to service_role;

revoke all on function public.archive_credential_used_gb(uuid, numeric) from public;
grant execute on function public.archive_credential_used_gb(uuid, numeric) to service_role;

revoke all on function public.topup_credential(uuid, uuid, numeric) from public;
grant execute on function public.topup_credential(uuid, uuid, numeric) to service_role;

-- Postgres doesn't auto-grant sequence USAGE to PUBLIC by default, so this
-- is belt-and-suspenders rather than closing a real hole — but it matches
-- the explicit deny-by-default posture this whole section establishes.
-- nextval() only needs to work for claim_and_credit_order's definer (the
-- function is `security definer`); no caller ever needs direct access.
revoke all on sequence public.invoice_number_seq from public;

-- Any function created after this point defaults to service_role-only —
-- closes the gap for the next RPC function someone adds without thinking
-- about grants. Explicit opt-in required for authenticated/anon access.
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public grant execute on functions to service_role;

-- ============================================================
-- Migration tracking — see migration 0027
-- ============================================================
-- The record of which migrations have actually been run against this
-- database, as opposed to which ones exist in supabase/migrations/ on
-- disk. Every migration from 0027 onward inserts its own filename here
-- as its last statement — scripts/check-migrations-applied.mjs diffs
-- this table against the folder to answer "is this database actually
-- caught up," a question nothing before 0027 could answer.
create table if not exists public.schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now()
);

alter table public.schema_migrations enable row level security;
-- No policies granted — service_role bypasses RLS, and there's no
-- legitimate reason for any client-side role to read or write this.
