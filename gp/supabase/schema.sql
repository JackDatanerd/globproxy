-- ============================================================
-- GLOBPROXY — FULL DATABASE SCHEMA
-- Run this entire file in Supabase SQL Editor (fresh project)
-- ============================================================
--
-- INCLUDES MIGRATIONS THROUGH: 0077_auth_mfa_pass6.sql
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
  -- Affiliate payout method — see migration 0034. payout_method_updated_at
  -- is never set directly by the user (protect_privileged_profile_columns
  -- below enforces this) — only via the update-payout-method route, which
  -- always sets it server-side. That timestamp is what the 48h hold in
  -- run_affiliate_payout_cycle checks against.
  payout_method              text check (payout_method is null or payout_method in ('usdt', 'bank', 'mpesa')),
  payout_wallet_address      text,
  payout_wallet_network      text check (payout_wallet_network is null or payout_wallet_network = 'TRC20'),
  payout_bank_details        jsonb,
  payout_mpesa_phone         text,
  payout_method_updated_at   timestamp with time zone,
  -- Verified Operators — see migration 0037. A hand-picked subset of
  -- already-approved affiliates given a distinguishing flag plus a
  -- higher rate (set directly on affiliate_commission_rate(_lifetime)
  -- above via the grant route — no separate rate columns needed here).
  is_verified_operator       boolean not null default false,
  verified_operator_since    timestamp with time zone,
  -- Rates held before a Verified Operator grant, restored on revoke — see migration 0043.
  verified_operator_prev_rate          numeric check (verified_operator_prev_rate is null or (verified_operator_prev_rate >= 0 and verified_operator_prev_rate <= 1)),
  verified_operator_prev_rate_lifetime numeric check (verified_operator_prev_rate_lifetime is null or (verified_operator_prev_rate_lifetime >= 0 and verified_operator_prev_rate_lifetime <= 1)),
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
  -- Migration 0042: de-dupe flags for the webhook-only threshold task (independent of the email flags above).
  wh_alerted_80_at  timestamptz,
  wh_alerted_95_at  timestamptz,
  wh_alerted_100_at timestamptz,
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
  invoice_number      text unique,
  -- Migration 0036: populated by webhooks/paystack's charge.failed handler
  -- the moment a decline happens, instead of the 24h cleanup cron flipping
  -- payment_status to 'failed' with no reason recorded, hours later.
  failure_reason      text,
  failed_at           timestamp with time zone,
  -- Migration 0036: marks the daily automated end-to-end payment test
  -- (cron 'canary' task) so it's excluded from revenue/summary numbers.
  is_canary           boolean not null default false,
  -- Migration 0038: refund bookkeeping + reconcile cron cursor.
  refunded_usd        numeric not null default 0,
  refunded_at         timestamptz,
  reconcile_checked_at timestamptz,
  post_credit_done_at  timestamptz -- 0041: stamped once activation + referral follow-ups succeed
);

create unique index if not exists orders_paystack_reference_key
  on public.orders (paystack_reference) where paystack_reference is not null;
create index if not exists orders_reconcile_idx
  on public.orders (created_at)
  where bandwidth_credited = false and payment_status in ('pending','cancelled','failed');

-- Migration 0038: refund ledger (service-role only, idempotent per Paystack refund reference).
create table if not exists public.order_refunds (
  refund_reference text primary key,
  order_id         uuid not null references public.orders(id) on delete cascade,
  amount_usd       numeric not null,
  gb_clawed        numeric not null default 0,
  gb_shortfall     numeric not null default 0,
  created_at       timestamptz not null default now()
);
create index if not exists idx_order_refunds_order on public.order_refunds(order_id);
alter table public.order_refunds enable row level security;

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

-- ── AFFILIATE PAYOUTS (biweekly cycles) ──────────────────────────
-- See migration 0034 for full rationale. One row per affiliate per cycle
-- that actually got batched — held/under-minimum affiliates get no row
-- and their commissions simply stay unbatched until a future cycle
-- claims them.
create table public.affiliate_payouts (
  id                    uuid default uuid_generate_v4() primary key,
  referrer_id           uuid references public.profiles(id) on delete cascade not null,
  cycle_start           date not null,
  cycle_end             date not null,
  amount_usd            numeric not null,
  status                text not null default 'pending' check (status in ('pending', 'paid')),
  payout_method         text not null,
  payout_wallet_address text,
  payout_wallet_network text,
  payout_bank_details   jsonb,
  payout_mpesa_phone    text,
  created_at            timestamp with time zone default now(),
  paid_at               timestamp with time zone,
  notified_at           timestamp with time zone,
  paid_by               uuid references public.profiles(id) on delete set null,
  payment_reference     text,
  unique (referrer_id, cycle_start, cycle_end)
);

create index if not exists idx_affiliate_payouts_referrer on public.affiliate_payouts(referrer_id);
create index if not exists idx_affiliate_payouts_status on public.affiliate_payouts(status);

alter table public.affiliate_commissions add column payout_id uuid references public.affiliate_payouts(id) on delete set null;
create index if not exists idx_affiliate_commissions_payout on public.affiliate_commissions(payout_id);

create or replace function public.run_affiliate_payout_cycle(
  p_cycle_start date,
  p_cycle_end date,
  p_min_payout_usd numeric default 20,
  p_hold_hours integer default 48
)
returns table (
  out_referrer_id uuid,
  out_status text,
  out_amount_usd numeric,
  out_payout_id uuid
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
  v_status text;
  v_new_payout_id uuid;
  v_method text;
  v_method_updated timestamptz;
  v_wallet_address text;
  v_wallet_network text;
  v_bank jsonb;
  v_mpesa_phone text;
  v_affiliate_status text;
  v_deleted boolean;
  v_suspended boolean;
  v_claimed_total numeric;
begin
  -- No lower bound on created_at: anything unbatched and pending that was
  -- earned on or before the cycle end is payable now. This is what makes
  -- "rolls over to the next payout automatically" actually true.
  for r in
    select ac.referrer_id as rid, sum(ac.commission_amount_usd) as total
    from public.affiliate_commissions ac
    where ac.payout_id is null
      and ac.status = 'pending'
      and ac.created_at::date <= p_cycle_end
    group by ac.referrer_id
  loop
    select payout_method, payout_method_updated_at, payout_wallet_address, payout_wallet_network,
           payout_bank_details, payout_mpesa_phone, affiliate_status, is_deleted, is_suspended
      into v_method, v_method_updated, v_wallet_address, v_wallet_network,
           v_bank, v_mpesa_phone, v_affiliate_status, v_deleted, v_suspended
    from public.profiles where id = r.rid;

    if coalesce(v_deleted, false) or coalesce(v_suspended, false) or v_affiliate_status is distinct from 'approved' then
      v_status := 'ineligible';
    elsif v_method is null then
      v_status := 'no_payout_method';
    elsif v_method_updated is null or v_method_updated > (now() - (p_hold_hours || ' hours')::interval) then
      v_status := 'held_recent_method';
    elsif r.total < p_min_payout_usd then
      v_status := 'below_minimum';
    else
      v_status := 'created';
    end if;

    v_new_payout_id := null;
    out_amount_usd := r.total;

    if v_status = 'created' then
      insert into public.affiliate_payouts
        (referrer_id, cycle_start, cycle_end, amount_usd, status,
         payout_method, payout_wallet_address, payout_wallet_network, payout_bank_details, payout_mpesa_phone)
      values
        (r.rid, p_cycle_start, p_cycle_end, r.total, 'pending',
         v_method, v_wallet_address, v_wallet_network, v_bank, v_mpesa_phone)
      on conflict (referrer_id, cycle_start, cycle_end) do nothing
      returning id into v_new_payout_id;

      if v_new_payout_id is not null then
        -- Claim first, then size the payout from what was really claimed.
        with claimed as (
          update public.affiliate_commissions
          set payout_id = v_new_payout_id
          where referrer_id = r.rid
            and payout_id is null
            and status = 'pending'
            and created_at::date <= p_cycle_end
          returning commission_amount_usd
        )
        select coalesce(sum(commission_amount_usd), 0) into v_claimed_total from claimed;

        if v_claimed_total is distinct from r.total then
          update public.affiliate_payouts set amount_usd = v_claimed_total where id = v_new_payout_id;
        end if;
        out_amount_usd := v_claimed_total;
      else
        -- This referrer already has a payout row for this exact cycle.
        -- Leave the commissions unclaimed; the next cycle picks them up.
        v_status := 'already_run';
      end if;
    end if;

    out_referrer_id := r.rid;
    out_status := v_status;
    out_payout_id := v_new_payout_id;
    return next;
  end loop;
end;
$$;

create or replace function public.mark_affiliate_payout_paid(
  p_payout_id uuid,
  p_paid_by uuid default null,
  p_reference text default null
)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_claimed uuid;
begin
  update public.affiliate_payouts
  set status = 'paid', paid_at = now(), paid_by = p_paid_by, payment_reference = nullif(btrim(p_reference), '')
  where id = p_payout_id and status = 'pending'
  returning id into v_claimed;

  if v_claimed is null then
    return false;
  end if;

  update public.affiliate_commissions
  set status = 'paid', paid_at = now()
  where payout_id = v_claimed and status = 'pending';

  return true;
end;
$$;

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
-- with AFFILIATE_INTRO_WINDOW_DAYS in lib/referrals.ts) after the referral
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
  upstream_sub_user_id  text, -- upstream supplier's numeric sub-user ID; required for usage/delete calls, NOT upstream_username
  upstream_username     text,
  upstream_password     text,
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
  -- Migration 0042: provisioning-retry bookkeeping + usage-read throttle.
  provisioning_claimed_at timestamptz,
  provision_attempts      integer not null default 0,
  last_provision_error    text,
  -- Migration 0046: once-per-exhaustion notice flag for this credential.
  exhausted_alerted_at    timestamptz,
  usage_synced_at         timestamptz,
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
  v_claimed  uuid;
  v_amount   numeric;
  v_refunded numeric;
  v_credit   numeric;
begin
  update public.orders
  set payment_status     = 'paid',
      paystack_reference = p_paystack_reference,
      bandwidth_credited = true,
      paid_at            = now(),
      failure_reason     = null,
      failed_at          = null,
      invoice_number     = case
        when is_canary then null
        else 'INV-' || to_char(now() at time zone 'UTC', 'YYYY')
             || '-' || lpad(nextval('public.invoice_number_seq')::text, 6, '0')
      end,
      -- Buyer details as they are today, frozen onto the invoice.
      billing_details    = (
        select jsonb_strip_nulls(jsonb_build_object(
          'name',    coalesce(nullif(btrim(pr.company_name), ''), nullif(btrim(pr.full_name), '')),
          'contact', nullif(btrim(pr.full_name), ''),
          'email',   pr.email,
          'address', nullif(btrim(pr.billing_address), ''),
          'tax_id',  nullif(btrim(pr.tax_id), '')
        ))
        from public.profiles pr where pr.id = p_user_id
      )
  where id = p_order_id
    and user_id = p_user_id
    and bandwidth_credited = false
    and payment_status in ('pending', 'cancelled', 'failed')
  returning id, amount_usd, coalesce(refunded_usd, 0) into v_claimed, v_amount, v_refunded;

  if v_claimed is null then
    return false; -- already credited, refunded, or not this user's order
  end if;

  -- A refund that landed before this credit (see apply_order_refund) already
  -- gave that share of the money back: credit only what is still paid for.
  v_credit := case
    when v_refunded > 0 and v_amount > 0
      then round(p_gb * greatest(v_amount - v_refunded, 0) / v_amount, 6)
    else p_gb
  end;

  if v_credit > 0 then
    perform public.credit_bandwidth(p_user_id, v_credit); -- uncaught error rolls the claim back too
  end if;

  return true;
end;
$$;

-- Migration 0038: refund application (claws back proportional GB).
create or replace function public.apply_order_refund(
  p_order_id uuid,
  p_refund_reference text,
  p_refund_usd numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order     public.orders%rowtype;
  v_credited  boolean;
  v_refund    numeric;
  v_gb        numeric;
  v_avail     numeric;
  v_claw      numeric;
  v_inserted  text;
  v_total     numeric;
  v_note      text;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('applied', false, 'reason', 'order_not_found');
  end if;

  -- Serialised by the order lock above, so a redelivered refund event is a
  -- clean no-op that does not burn a credit-note number.
  if exists (select 1 from public.order_refunds where refund_reference = p_refund_reference) then
    return jsonb_build_object('applied', false, 'reason', 'duplicate');
  end if;

  v_credited := v_order.bandwidth_credited is true;
  -- An uncredited order can still have been paid (webhook delayed): refunds
  -- against it are recorded. Anything else uncredited is not a real payment.
  if not v_credited and v_order.payment_status not in ('pending', 'cancelled', 'failed') then
    return jsonb_build_object('applied', false, 'reason', 'order_never_credited');
  end if;

  v_refund := least(p_refund_usd, v_order.amount_usd - v_order.refunded_usd);
  if v_refund is null or v_refund <= 0 then
    return jsonb_build_object('applied', false, 'reason', 'nothing_to_refund');
  end if;

  if v_credited then
    v_gb := round(v_order.gb_amount * v_refund / v_order.amount_usd, 6);
    select available_gb into v_avail
    from public.bandwidth_accounts where user_id = v_order.user_id for update;
    v_claw := least(v_gb, greatest(coalesce(v_avail, 0), 0));
  else
    v_gb := 0;
    v_claw := 0;
  end if;

  v_note := 'CN-' || to_char(now() at time zone 'UTC', 'YYYY')
            || '-' || lpad(nextval('public.credit_note_seq')::text, 6, '0');

  insert into public.order_refunds (refund_reference, order_id, amount_usd, gb_clawed, gb_shortfall, credit_note_number)
  values (p_refund_reference, p_order_id, v_refund, v_claw, v_gb - v_claw, v_note)
  on conflict (refund_reference) do nothing
  returning refund_reference into v_inserted;

  if v_inserted is null then
    return jsonb_build_object('applied', false, 'reason', 'duplicate');
  end if;

  if v_claw > 0 then
    update public.bandwidth_accounts
    set total_gb = total_gb - v_claw
    where user_id = v_order.user_id;
  end if;

  v_total := v_order.refunded_usd + v_refund;
  update public.orders
  set refunded_usd   = v_total,
      refunded_at    = now(),
      payment_status = case when v_total >= amount_usd then 'refunded' else payment_status end
  where id = p_order_id;

  return jsonb_build_object(
    'applied', true,
    'credited', v_credited,
    'refund_usd', v_refund,
    'gb_clawed', v_claw,
    'gb_shortfall', v_gb - v_claw,
    'fully_refunded', v_total >= v_order.amount_usd,
    'credit_note', v_note
  );
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

-- Migration 0046 — auto top-up decided under the row lock; per-account credential cap.
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
  revoked_at   timestamp with time zone,
  -- Migration 0042
  scopes       text[] not null default array['read','write']::text[],
  expires_at   timestamptz,
  last_used_ip text,
  allowed_ips  text[] not null default '{}'::text[],
  constraint api_keys_valid_scopes check (scopes <@ array['read','write']::text[] and cardinality(scopes) > 0)
);

create index api_keys_user_id_idx on public.api_keys(user_id);

alter table public.api_keys enable row level security;

create policy "Users can view own api keys"
  on public.api_keys for select using (auth.uid() = user_id);
-- Migration 0042: no client UPDATE policy — revocation goes through
-- /api/dashboard/api-keys with the admin client after an ownership check.

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

create trigger api_keys_enforce_limit
  before insert on public.api_keys
  for each row execute function public.enforce_api_key_limit();

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
  -- Migration 0042
  description          text,
  consecutive_failures integer not null default 0,
  disabled_at          timestamptz,
  disabled_reason      text,
  constraint webhook_endpoints_https_only check (url ~* '^https://'),
  -- Defense-in-depth alongside the app-layer check in the API routes —
  -- even a bug in application code can't get an unrecognized event type
  -- persisted here.
  constraint webhook_endpoints_valid_events
    check (event_types <@ array[
    'session_created', 'session_activated', 'session_deleted', 'session_topped_up',
    'session_exhausted',
    'auto_topup_triggered', 'auto_topup_failed',
    'bandwidth_threshold_crossed', 'bandwidth_exhausted', 'bandwidth_credited'
  ]::text[])
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


-- ── Migration 0042: webhook limit trigger, delivery log, attempt bookkeeping ──
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

create trigger webhook_endpoints_enforce_limit
  before insert on public.webhook_endpoints
  for each row execute function public.enforce_webhook_endpoint_limit();

-- One row per (event, endpoint). `payload` is the exact JSON body that is
-- signed, so retries and manual redeliveries send byte-identical bodies.
create table public.webhook_deliveries (
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

create index webhook_deliveries_endpoint_idx
  on public.webhook_deliveries (endpoint_id, created_at desc);
create index webhook_deliveries_user_event_idx
  on public.webhook_deliveries (user_id, event_type, created_at desc);
create index webhook_deliveries_due_idx
  on public.webhook_deliveries (next_attempt_at) where status = 'retrying';

alter table public.webhook_deliveries enable row level security;

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


-- ── Migration 0042: pending-credential provisioning claim ──
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


-- ── Migration 0042: idempotency keys for POST /api/v1/sub-users ──
create table public.api_idempotency_keys (
  user_id          uuid not null references public.profiles(id) on delete cascade,
  key              text not null,
  request_hash     text not null,
  status           text not null default 'in_progress' check (status in ('in_progress','completed')),
  response_status  integer,
  response_body    jsonb,
  created_at       timestamptz not null default now(),
  primary key (user_id, key)
);
create index api_idempotency_keys_created_idx on public.api_idempotency_keys (created_at);
alter table public.api_idempotency_keys enable row level security;
-- No policies: service role only.


-- ── SUPPORT REPORTS ────────────────────────────────────────────
-- Migration 0036. Backs the in-app "Report an issue" button
-- (components/dashboard/ReportIssueButton.tsx) added after payments
-- silently failed with no visibility — /api/support/report writes here
-- and emails admin immediately, same as the payment-failure alert.
create table public.support_reports (
  id            uuid default uuid_generate_v4() primary key,
  user_id       uuid references public.profiles(id) on delete set null,
  email         text not null,
  page_url      text,
  message       text not null,
  status        text not null default 'open' check (status in ('open','resolved')),
  created_at    timestamptz default now(),
  resolved_at   timestamptz
);

create index idx_support_reports_status on public.support_reports(status);

alter table public.support_reports enable row level security;

-- No insert policy for anon/authenticated — the API route always writes
-- through the admin client (same pattern as orders/checkout), same reason
-- referrals has no direct-write policy either. These two are read-only
-- policies for users viewing their own submitted reports.
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

create policy "User can view own reports" on public.support_reports for select
  using (auth.uid() = user_id);

create policy "Admins can view all reports" on public.support_reports for select
  using (public.is_admin(auth.uid()));

create policy "Admins can update reports" on public.support_reports for update
  using (public.is_admin(auth.uid()));

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
alter table public.affiliate_payouts     enable row level security;
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

-- (public.is_admin() is defined much earlier in this file — see the block
-- just above the support_reports policies. It used to live here, AFTER the
-- support_reports policies that call it, so a fresh run of this file failed
-- to create those two admin policies.)

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
  new.email                              := old.email; -- see migration 0011
  new.affiliate_status                   := old.affiliate_status; -- see migration 0031
  new.affiliate_commission_rate          := old.affiliate_commission_rate;
  new.affiliate_commission_rate_lifetime := old.affiliate_commission_rate_lifetime;
  new.payout_method                      := old.payout_method; -- see migration 0034, extended by 0035
  new.payout_wallet_address              := old.payout_wallet_address;
  new.payout_wallet_network              := old.payout_wallet_network;
  new.payout_bank_details                := old.payout_bank_details;
  new.payout_mpesa_phone                 := old.payout_mpesa_phone;
  new.payout_method_updated_at           := old.payout_method_updated_at;
  new.is_verified_operator               := old.is_verified_operator; -- see migration 0037
  new.verified_operator_since            := old.verified_operator_since;
  new.verified_operator_prev_rate        := old.verified_operator_prev_rate; -- see migration 0043
  new.verified_operator_prev_rate_lifetime := old.verified_operator_prev_rate_lifetime;
  new.mfa_enabled                        := old.mfa_enabled; -- see migration 0039_auth_mfa_hardening

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

  new.user_id               := old.user_id;
  new.plan_id               := old.plan_id;
  new.gb_amount             := old.gb_amount;
  new.amount_usd            := old.amount_usd;
  new.payment_method        := old.payment_method;
  new.paystack_reference    := old.paystack_reference;
  new.bandwidth_credited    := old.bandwidth_credited;
  new.paid_at               := old.paid_at;
  new.created_at            := old.created_at;
  new.invoice_number        := old.invoice_number;
  new.failure_reason        := old.failure_reason;
  new.failed_at             := old.failed_at;
  new.is_canary             := old.is_canary;
  new.refunded_usd          := old.refunded_usd;
  new.refunded_at           := old.refunded_at;
  new.reconcile_checked_at  := old.reconcile_checked_at;
  new.post_credit_done_at   := old.post_credit_done_at;
  new.billing_details       := old.billing_details;
  new.dispute_status        := old.dispute_status;
  new.dispute_opened_at     := old.dispute_opened_at;
  new.dispute_resolution    := old.dispute_resolution;
  new.pay_currency          := old.pay_currency;
  new.pay_amount            := old.pay_amount;
  new.fx_rate               := old.fx_rate;

  return new;
end;
$$;

create trigger protect_order_columns
  before update on public.orders
  for each row execute procedure public.protect_order_columns();

-- Credentials
create policy "Own or created credentials" on public.proxy_credentials for select
  using (auth.uid() = user_id or auth.uid() = created_by);
-- No INSERT / UPDATE / DELETE policies (and no table privileges, below):
-- every write to proxy_credentials is server-side via service_role. See
-- migration 0040 — the old insert/delete policies let any user forge rows.

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

create policy "Referrer can view own payouts" on public.affiliate_payouts for select
  using (auth.uid() = referrer_id);
create policy "Admins can view all payouts" on public.affiliate_payouts for select
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
-- and release_credential_bandwidth are service_role only (migration 0040).
-- 0040: reserve/release are service_role ONLY. They used to be granted to
-- `authenticated`, which let a user call release_credential_bandwidth
-- directly to hand back a live credential's reservation and mint bandwidth.
revoke all on function public.reserve_credential_bandwidth(uuid, numeric) from public, anon, authenticated;
grant execute on function public.reserve_credential_bandwidth(uuid, numeric) to service_role;

revoke all on function public.release_credential_bandwidth(uuid, numeric) from public, anon, authenticated;
grant execute on function public.release_credential_bandwidth(uuid, numeric) to service_role;

revoke all on function public.record_webhook_attempt(uuid, boolean, text, integer, text) from public, anon, authenticated;
grant execute on function public.record_webhook_attempt(uuid, boolean, text, integer, text) to service_role;

revoke all on function public.claim_pending_credentials(integer, uuid, boolean) from public, anon, authenticated;
grant execute on function public.claim_pending_credentials(integer, uuid, boolean) to service_role;

revoke all on function public.enforce_api_key_limit() from public, anon, authenticated;
revoke all on function public.enforce_webhook_endpoint_limit() from public, anon, authenticated;

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

revoke all on function public.run_affiliate_payout_cycle(date, date, numeric, integer) from public;
grant execute on function public.run_affiliate_payout_cycle(date, date, numeric, integer) to service_role;

revoke all on function public.mark_affiliate_payout_paid(uuid, uuid, text) from public;
grant execute on function public.mark_affiliate_payout_paid(uuid, uuid, text) to service_role;

revoke all on function public.claim_and_credit_order(uuid, uuid, numeric, text) from public;
grant execute on function public.claim_and_credit_order(uuid, uuid, numeric, text) to service_role;

revoke all on function public.apply_order_refund(uuid, text, numeric) from public;
grant execute on function public.apply_order_refund(uuid, text, numeric) to service_role;

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

-- ── 0039: Auth & MFA hardening (sections 2–5; section 1 is folded into protect_privileged_profile_columns above) ──
-- ── 2. Atomic attempt budget / TOTP consumption ─────────────────
-- Returns: 'ok'     — slot reserved, go ahead and check the code
--          'ok_last'— slot reserved and it was the last one; the factor is
--                     now locked for p_lock_seconds unless this attempt succeeds
--          'locked' — currently locked, do not check the code
--          'missing'— no factor row
create or replace function public.mfa_begin_attempt(
  p_user_id uuid,
  p_max integer,
  p_lock_seconds integer
)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row public.mfa_totp_factors%rowtype;
  v_attempts integer;
begin
  select * into v_row from public.mfa_totp_factors where user_id = p_user_id for update;
  if not found then
    return 'missing';
  end if;

  if v_row.locked_until is not null and v_row.locked_until > now() then
    return 'locked';
  end if;

  -- An expired lock starts a fresh budget.
  v_attempts := case when v_row.locked_until is not null then 1 else v_row.failed_attempts + 1 end;

  if v_attempts >= p_max then
    update public.mfa_totp_factors
      set failed_attempts = 0,
          locked_until = now() + make_interval(secs => p_lock_seconds)
      where user_id = p_user_id;
    return 'ok_last';
  end if;

  update public.mfa_totp_factors
    set failed_attempts = v_attempts,
        locked_until = null
    where user_id = p_user_id;
  return 'ok';
end;
$$;

revoke all on function public.mfa_begin_attempt(uuid, integer, integer) from public;
grant execute on function public.mfa_begin_attempt(uuid, integer, integer) to service_role;

-- Compare-and-set: succeeds only if p_counter is strictly newer than the
-- last consumed one. A success also clears the failure counter and lock.
create or replace function public.mfa_consume_totp(p_user_id uuid, p_counter bigint)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.mfa_totp_factors
    set last_used_counter = p_counter,
        last_used_at = now(),
        failed_attempts = 0,
        locked_until = null
    where user_id = p_user_id
      and (last_used_counter is null or last_used_counter < p_counter);
  return found;
end;
$$;

revoke all on function public.mfa_consume_totp(uuid, bigint) from public;
grant execute on function public.mfa_consume_totp(uuid, bigint) to service_role;

-- Clears failures after a successful BACKUP-code check (which has its own
-- single-use protection via mfa_backup_codes.used_at).
create or replace function public.mfa_clear_failures(p_user_id uuid)
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.mfa_totp_factors
    set failed_attempts = 0, locked_until = null, last_used_at = now()
    where user_id = p_user_id;
$$;

revoke all on function public.mfa_clear_failures(uuid) from public;
grant execute on function public.mfa_clear_failures(uuid) to service_role;

create or replace function public.mfa_refund_attempt(p_user_id uuid)
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.mfa_totp_factors
    set failed_attempts = greatest(failed_attempts - 1, 0)
    where user_id = p_user_id and failed_attempts > 0;
$$;

revoke all on function public.mfa_refund_attempt(uuid) from public;
grant execute on function public.mfa_refund_attempt(uuid) to service_role;

-- ── 3. Security events ──────────────────────────────────────────
create table if not exists public.security_events (
  id           uuid default uuid_generate_v4() primary key,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  actor_id     uuid,                       -- set when someone other than the user caused it (admin MFA reset)
  event        text not null,
  ip           text,
  user_agent   text,
  meta         jsonb not null default '{}'::jsonb,
  notify       boolean not null default false,   -- an email is owed for this event
  notified_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists security_events_user_created_idx
  on public.security_events(user_id, created_at desc);
create index if not exists security_events_pending_notice_idx
  on public.security_events(created_at) where notify and notified_at is null;
create index if not exists security_events_login_ua_idx
  on public.security_events(user_id, (meta->>'ua_hash')) where event = 'login';

alter table public.security_events enable row level security;

drop policy if exists "Own security events" on public.security_events;
create policy "Own security events" on public.security_events
  for select using (auth.uid() = user_id);
-- No insert/update/delete policies: every write goes through the
-- service-role client (lib/securityEvents.ts) or the triggers below.

create or replace function public.cleanup_old_security_events()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_deleted integer;
begin
  delete from public.security_events where created_at < now() - interval '365 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.cleanup_old_security_events() from public, anon, authenticated;
grant execute on function public.cleanup_old_security_events() to service_role;

-- ── 4. Password-change trigger ──────────────────────────────────
create or replace function public.on_auth_password_changed()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.encrypted_password is distinct from old.encrypted_password
     and old.encrypted_password is not null then
    delete from public.mfa_verified_sessions where user_id = new.id;
    insert into public.security_events (user_id, event, notify, meta)
    select new.id, 'password_changed', true, jsonb_build_object('source', 'db_trigger')
    where exists (select 1 from public.profiles where id = new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_password_changed on auth.users;
create trigger on_auth_user_password_changed
  after update of encrypted_password on auth.users
  for each row execute procedure public.on_auth_password_changed();

-- ── 5. Unconfirmed-account lookup ───────────────────────────────
create or replace function public.auth_email_unconfirmed(check_email text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from auth.users
    where lower(email) = lower(check_email)
      and email_confirmed_at is null
      and (banned_until is null or banned_until < now())
  );
$$;

revoke all on function public.auth_email_unconfirmed(text) from public, anon, authenticated;
grant execute on function public.auth_email_unconfirmed(text) to service_role;

-- ── 0040: proxy_credentials lockdown ───────────────────────────
-- 2. proxy_credentials: read-only for end users ------------------------
drop policy if exists "Create own credentials" on public.proxy_credentials;
drop policy if exists "Delete own unassigned credentials" on public.proxy_credentials;

revoke insert, update, delete on public.proxy_credentials from anon, authenticated;

-- A Geonode sub-user belongs to exactly one credential row. Partial unique
-- index so the many NULL (pending) rows are unaffected. If this fails, the
-- audit query above found duplicates: resolve those rows first.
create unique index if not exists proxy_credentials_upstream_sub_user_key
  on public.proxy_credentials (upstream_sub_user_id)
  where upstream_sub_user_id is not null;

alter table public.proxy_credentials
  drop constraint if exists proxy_credentials_gb_allocated_sane;
alter table public.proxy_credentials
  add constraint proxy_credentials_gb_allocated_sane
  check (gb_allocated >= 0 and gb_allocated <= 100000) not valid;

alter table public.proxy_credentials
  drop constraint if exists proxy_credentials_gb_used_nonneg;
alter table public.proxy_credentials
  add constraint proxy_credentials_gb_used_nonneg
  check (gb_used is null or gb_used >= 0) not valid;

-- 3. Atomic delete of a self-created credential ------------------------
-- p_live_used_gb is the live Geonode figure the route fetched before
-- deleting the sub-user (NULL if that call failed). The larger of it and
-- the last synced gb_used is treated as consumed, so a failed or stale
-- live read can never under-count usage and hand back too much.
create or replace function public.delete_own_credential(
  p_credential_id uuid,
  p_user_id uuid,
  p_live_used_gb numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cred     public.proxy_credentials%rowtype;
  v_used     numeric;
  v_release  numeric;
begin
  select * into v_cred
  from public.proxy_credentials
  where id = p_credential_id
    and user_id = p_user_id
    and created_by is null
  for update;

  if not found then
    raise exception 'Credential not found' using errcode = 'P0002';
  end if;

  v_used    := greatest(coalesce(p_live_used_gb, 0), coalesce(v_cred.gb_used, 0), 0);
  v_release := greatest(0, v_cred.gb_allocated - v_used);

  delete from public.proxy_credentials where id = v_cred.id;

  update public.bandwidth_accounts
  set allocated_gb     = greatest(0, allocated_gb - v_release),
      archived_used_gb = archived_used_gb + v_used
  where user_id = p_user_id;

  return jsonb_build_object('released_gb', v_release, 'archived_gb', v_used);
end;
$$;

revoke all on function public.delete_own_credential(uuid, uuid, numeric) from public, anon, authenticated;
grant execute on function public.delete_own_credential(uuid, uuid, numeric) to service_role;

-- ── 0041: retriable post-credit steps ──────────────────────────
create index if not exists orders_post_credit_pending_idx
  on public.orders (paid_at)
  where bandwidth_credited = true and post_credit_done_at is null;

-- ── 0042 §1b: close the direct anon/authenticated EXECUTE grants on every SECURITY DEFINER function ──
-- (see migrations/0042_api_integrations_hardening.sql for the full explanation and the verification query)
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

insert into public.schema_migrations (filename) values
  ('0039_auth_mfa_hardening.sql'),
  ('0040_proxy_credentials_lockdown.sql'),
  ('0041_post_credit_retry.sql'),
  ('0042_api_integrations_hardening.sql')
on conflict do nothing;

-- ============================================================
-- Admin hardening — see migration 0043
-- ============================================================
create table if not exists public.admin_audit_log (
  id              uuid default uuid_generate_v4() primary key,
  admin_id        uuid references public.profiles(id) on delete set null,
  action          text not null,
  target_user_id  uuid references public.profiles(id) on delete set null,
  target_ref      text,
  details         jsonb not null default '{}'::jsonb,
  created_at      timestamp with time zone not null default now()
);

create index if not exists idx_admin_audit_log_created on public.admin_audit_log(created_at desc);
create index if not exists idx_admin_audit_log_target on public.admin_audit_log(target_user_id, created_at desc);

alter table public.admin_audit_log enable row level security;

drop policy if exists "Admins can read audit log" on public.admin_audit_log;
create policy "Admins can read audit log" on public.admin_audit_log for select
  using (public.is_admin(auth.uid()));

create or replace function public.reduce_commission_on_refund()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c record;
  v_ratio numeric;
  v_new numeric;
  v_delta numeric;
begin
  if coalesce(new.refunded_usd, 0) <= coalesce(old.refunded_usd, 0) or coalesce(new.amount_usd, 0) <= 0 then
    return new;
  end if;

  v_ratio := least(new.refunded_usd / new.amount_usd, 1);

  select * into c from public.affiliate_commissions where order_id = new.id for update;
  if not found then
    return new;
  end if;

  if c.status = 'paid' then
    -- Already paid out — cannot be clawed back automatically. Leave a
    -- trail so an admin can follow up with the affiliate.
    insert into public.admin_audit_log (admin_id, action, target_user_id, target_ref, details)
    values (null, 'commission_refund_after_paid', c.referrer_id, new.id::text,
            jsonb_build_object('commission_id', c.id, 'commission_amount_usd', c.commission_amount_usd,
                               'order_refunded_usd', new.refunded_usd, 'order_amount_usd', new.amount_usd));
    return new;
  end if;

  if c.status <> 'pending' then
    return new; -- void already
  end if;

  v_new := case when v_ratio >= 1 then 0
                else round(c.gross_amount_usd * (1 - v_ratio) * c.commission_rate, 2) end;
  v_delta := c.commission_amount_usd - v_new;
  if v_delta <= 0 then
    return new;
  end if;

  update public.affiliate_commissions
  set commission_amount_usd = v_new,
      status = case when v_new = 0 then 'void' else status end
  where id = c.id;

  if c.payout_id is not null then
    update public.affiliate_payouts
    set amount_usd = greatest(amount_usd - v_delta, 0)
    where id = c.payout_id and status = 'pending';
  end if;

  return new;
end;
$$;

revoke all on function public.reduce_commission_on_refund() from public, anon, authenticated;

drop trigger if exists trg_reduce_commission_on_refund on public.orders;
create trigger trg_reduce_commission_on_refund
  after update of refunded_usd on public.orders
  for each row execute function public.reduce_commission_on_refund();

create or replace function public.apply_refund_to_new_commission()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_amount numeric;
  v_refunded numeric;
  v_ratio numeric;
begin
  select amount_usd, coalesce(refunded_usd, 0) into v_amount, v_refunded
  from public.orders where id = new.order_id;

  if coalesce(v_refunded, 0) > 0 and coalesce(v_amount, 0) > 0 then
    v_ratio := least(v_refunded / v_amount, 1);
    if v_ratio >= 1 then
      new.commission_amount_usd := 0;
      new.status := 'void';
    else
      new.commission_amount_usd := round(new.gross_amount_usd * (1 - v_ratio) * new.commission_rate, 2);
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.apply_refund_to_new_commission() from public, anon, authenticated;

drop trigger if exists trg_apply_refund_to_new_commission on public.affiliate_commissions;
create trigger trg_apply_refund_to_new_commission
  before insert on public.affiliate_commissions
  for each row execute function public.apply_refund_to_new_commission();

create or replace function public.admin_order_stats(
  p_start timestamptz default null,
  p_end   timestamptz default null
)
returns table (revenue_usd numeric, gb_sold numeric, order_count bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  select
    coalesce(sum(o.amount_usd - coalesce(o.refunded_usd, 0)), 0),
    coalesce(sum(o.gb_amount * (1 - least(coalesce(coalesce(o.refunded_usd, 0) / nullif(o.amount_usd, 0), 0), 1))), 0),
    count(*)
  from public.orders o
  where o.payment_status = 'paid'
    and o.is_canary = false
    and (p_start is null or o.created_at >= p_start)
    and (p_end   is null or o.created_at <  p_end);
$$;

revoke all on function public.admin_order_stats(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.admin_order_stats(timestamptz, timestamptz) to service_role;

create or replace function public.admin_affiliate_earnings()
returns table (referrer_id uuid, accruing_usd numeric, awaiting_usd numeric, paid_usd numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  select
    ac.referrer_id,
    coalesce(sum(ac.commission_amount_usd) filter (where ac.status = 'pending' and ac.payout_id is null), 0),
    coalesce(sum(ac.commission_amount_usd) filter (where ac.status = 'pending' and ac.payout_id is not null), 0),
    coalesce(sum(ac.commission_amount_usd) filter (where ac.status = 'paid'), 0)
  from public.affiliate_commissions ac
  group by ac.referrer_id;
$$;

revoke all on function public.admin_affiliate_earnings() from public, anon, authenticated;
grant execute on function public.admin_affiliate_earnings() to service_role;

alter function public.wipe_mfa(uuid) set search_path = public, pg_temp;

insert into public.schema_migrations (filename) values
  ('0043_admin_hardening.sql')
on conflict do nothing;

-- ════════════════════════════════════════════════════════════
-- Migration 0044 (section 7: reseller / referral / affiliate-payout hardening),
-- kept verbatim so a fresh bootstrap from this file matches a migrated
-- database. Supersedes the earlier definitions above of: record_referral_signup,
-- credit_referral_bonus, record_affiliate_commission, and
-- protect_privileged_profile_columns (rebased on 0043's body + referral_code).
-- ════════════════════════════════════════════════════════════
-- ============================================================
-- 0044 — Reseller / referral / affiliate-payout hardening (section 7, audit pass 1)
-- ============================================================
-- Idempotent: safe to re-run. Apply AFTER 0043_admin_hardening.sql.
--
-- Scope note: the concurrent Admin pass (0043) already closed the payout-side
-- bugs from this audit — carry-over of held-back commissions, claim-then-size,
-- ineligible (suspended/deleted) affiliates, the double-pay route, refund
-- reversal (trigger), payment reference + paid_by, the audit log, affiliate
-- suspend/reinstate/rates and Verified Operator prior-rate restore. Nothing
-- here redefines run_affiliate_payout_cycle, mark_affiliate_payout_paid,
-- admin_audit_log or the refund triggers. This migration only adds what that
-- pass did not cover:
--
-- REFERRALS
--  * G2  Attribution that survives browsing (sub-IDs, click counters) and a
--        post-signup claim_referral_code() (only before the first purchase).
--  * G3  Fraud controls: gmail-dot / +tag alias self-referral is refused,
--        a second signup from the same IP on the same referrer is FLAGGED, and
--        a flagged referral earns nothing (no GB bonus, no commission) until an
--        admin clears it. The standard GB bonus now needs a minimum order value.
--  * B9  Deleted / suspended referrers can no longer be attributed or credited.
--  * G6  Service-role summary + funnel RPCs for the affiliate dashboard (no
--        1000-row cap, nothing summed client-side).
--
-- PAYOUTS
--  * G4  void_affiliate_payout(): cancel a still-pending payout, release its
--        commissions, free the (referrer, cycle) slot, return the details so the
--        route can write them to admin_audit_log.
--  * B9  scrub_affiliate_data(): account deletion also suspends the affiliate
--        status and forfeits unbatched earnings.
--  * Account-security events (password change, MFA disable/reset, email change)
--        restart the 48h payout-method hold — the hold only protects anyone if
--        every account-takeover step restarts it.
--
-- RESELLERS
--  * B2  The "Resellers can view own client profiles" policy exposed the whole
--        profiles row (payout bank details, M-Pesa phone, application blobs…)
--        of every user a reseller had ever transferred to. Dropped; the reseller
--        UI reads a narrow SECURITY DEFINER roster instead.
--  * B14 allocate_reseller_bandwidth_tx(): ledger move AND history row in one
--        transaction, min 0.1 GB, max 3 decimals.
--  * G7  reclaim_reseller_allocation(), transfer notes, roster / summary RPCs.
--
-- PROFILES
--  * B17 referral_code is pinned by protect_privileged_profile_columns().
-- ============================================================

-- ── 1. Columns ───────────────────────────────────────────────

alter table public.referrals add column if not exists sub_id text;
alter table public.referrals add column if not exists signup_ip_hash text;
alter table public.referrals add column if not exists flagged boolean not null default false;
alter table public.referrals add column if not exists flag_reason text;
create index if not exists idx_referrals_ip
  on public.referrals (referrer_id, signup_ip_hash) where signup_ip_hash is not null;
create index if not exists idx_referrals_flagged on public.referrals (created_at desc) where flagged;

alter table public.reseller_transfers add column if not exists note text;
alter table public.reseller_transfers add column if not exists reclaimed_gb numeric not null default 0;
alter table public.reseller_transfers drop constraint if exists reseller_transfers_status_check;
alter table public.reseller_transfers
  add constraint reseller_transfers_status_check check (status in ('pending', 'active', 'reclaimed'));
create index if not exists idx_reseller_transfers_reseller on public.reseller_transfers (reseller_id, created_at desc);
create index if not exists idx_reseller_transfers_recipient on public.reseller_transfers (recipient_id);

-- ── 2. New tables ────────────────────────────────────────────

create table if not exists public.referral_clicks (
  referrer_id uuid not null references public.profiles(id) on delete cascade,
  day         date not null,
  clicks      integer not null default 0,
  primary key (referrer_id, day)
);
alter table public.referral_clicks enable row level security;
-- No policies: written by service role, read through my_affiliate_summary().

-- ── 3. B2: reseller profile-row exposure ─────────────────────

drop policy if exists "Resellers can view own client profiles" on public.profiles;

-- ── 4. protect_privileged_profile_columns (full body) ────────
-- Rebased on 0043_admin_hardening's definition (which includes the
-- verified_operator_prev_* columns and mfa_enabled); the only addition is
-- referral_code.
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
  new.email                              := old.email; -- see migration 0011
  new.affiliate_status                   := old.affiliate_status; -- see migration 0031
  new.affiliate_commission_rate          := old.affiliate_commission_rate;
  new.affiliate_commission_rate_lifetime := old.affiliate_commission_rate_lifetime;
  new.payout_method                      := old.payout_method; -- see migration 0034, extended by 0035
  new.payout_wallet_address              := old.payout_wallet_address;
  new.payout_wallet_network              := old.payout_wallet_network;
  new.payout_bank_details                := old.payout_bank_details;
  new.payout_mpesa_phone                 := old.payout_mpesa_phone;
  new.payout_method_updated_at           := old.payout_method_updated_at;
  new.is_verified_operator               := old.is_verified_operator; -- see migration 0037
  new.verified_operator_since            := old.verified_operator_since;
  new.verified_operator_prev_rate        := old.verified_operator_prev_rate; -- see migration 0043
  new.verified_operator_prev_rate_lifetime := old.verified_operator_prev_rate_lifetime;
  new.mfa_enabled                        := old.mfa_enabled; -- see migration 0039_auth_mfa_hardening
  new.referral_code                      := old.referral_code; -- migration 0044

  return new;
end;
$$;

-- ── 5. Referral attribution / bonus / commission ─────────────

create or replace function public.normalize_email_alias(p_email text)
returns text language plpgsql immutable as $$
declare
  v_local text;
  v_dom   text;
begin
  if p_email is null then return null; end if;
  p_email := lower(trim(p_email));
  v_local := split_part(p_email, '@', 1);
  v_dom   := split_part(p_email, '@', 2);
  v_local := split_part(v_local, '+', 1);
  if v_dom in ('gmail.com', 'googlemail.com') then
    v_local := replace(v_local, '.', '');
    v_dom   := 'gmail.com';
  end if;
  return v_local || '@' || v_dom;
end;
$$;

drop function if exists public.record_referral_signup(text, uuid);

create or replace function public.record_referral_signup(
  p_code        text,
  p_new_user_id uuid,
  p_sub_id      text default null,
  p_ip_hash     text default null
)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_code        text;
  v_referrer_id uuid;
  v_ref_email   text;
  v_new_email   text;
  v_deleted     boolean;
  v_suspended   boolean;
  v_flagged     boolean := false;
  v_flag_reason text;
  v_sub         text;
begin
  if p_code is null or p_new_user_id is null then
    return 'ignored';
  end if;
  v_code := upper(trim(p_code));
  if v_code = '' or length(v_code) > 32 then
    return 'invalid_code';
  end if;

  if exists (select 1 from public.referrals where referred_user_id = p_new_user_id) then
    return 'already_referred';
  end if;

  select id, email, is_deleted, is_suspended
    into v_referrer_id, v_ref_email, v_deleted, v_suspended
  from public.profiles where referral_code = v_code;

  if v_referrer_id is null then
    return 'invalid_code';
  end if;
  if v_referrer_id = p_new_user_id then
    return 'self_referral';
  end if;
  if coalesce(v_deleted, false) or coalesce(v_suspended, false) then
    return 'referrer_inactive';
  end if;

  select email into v_new_email from public.profiles where id = p_new_user_id;
  if v_new_email is null then
    return 'ignored';
  end if;
  if public.normalize_email_alias(v_new_email) = public.normalize_email_alias(v_ref_email) then
    return 'self_referral'; -- gmail dots / +tag alias of the referrer's own address
  end if;

  if p_ip_hash is not null and exists (
    select 1 from public.referrals
    where referrer_id = v_referrer_id and signup_ip_hash = p_ip_hash
  ) then
    v_flagged := true;
    v_flag_reason := 'shared_signup_ip';
  end if;

  v_sub := nullif(left(regexp_replace(coalesce(p_sub_id, ''), '[^A-Za-z0-9_-]', '', 'g'), 32), '');

  insert into public.referrals (referrer_id, referred_user_id, code_used, sub_id, signup_ip_hash, flagged, flag_reason)
  values (v_referrer_id, p_new_user_id, v_code, v_sub, p_ip_hash, v_flagged, v_flag_reason)
  on conflict (referred_user_id) do nothing;

  return case when v_flagged then 'recorded_flagged' else 'recorded' end;
end;
$$;

-- G2: attach a code AFTER signup — only before the account has paid for anything.
create or replace function public.claim_referral_code(
  p_code        text,
  p_user_id     uuid,
  p_sub_id      text default null,
  p_ip_hash     text default null
)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (
    select 1 from public.orders
    where user_id = p_user_id and bandwidth_credited = true and coalesce(is_canary, false) = false
  ) then
    return 'has_orders';
  end if;
  return public.record_referral_signup(p_code, p_user_id, p_sub_id, p_ip_hash);
end;
$$;

drop function if exists public.credit_referral_bonus(uuid, numeric);

create or replace function public.credit_referral_bonus(
  p_referral_id      uuid,
  p_gb               numeric,
  p_order_amount_usd numeric default null,
  p_min_order_usd    numeric default 0
)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_referrer_id uuid;
  v_referred_id uuid;
  v_claimed     uuid;
begin
  update public.referrals r
  set gb_bonus_credited_at = now(), gb_bonus_amount = p_gb
  from public.profiles pr
  where r.id = p_referral_id
    and r.gb_bonus_credited_at is null
    and r.flagged = false
    and pr.id = r.referrer_id
    and not coalesce(pr.is_deleted, false)
    and not coalesce(pr.is_suspended, false)
    and (p_order_amount_usd is null or p_order_amount_usd >= p_min_order_usd)
  returning r.id, r.referrer_id, r.referred_user_id into v_claimed, v_referrer_id, v_referred_id;

  if v_claimed is null then
    return false;
  end if;

  perform public.credit_bandwidth(v_referrer_id, p_gb);
  perform public.credit_bandwidth(v_referred_id, p_gb);
  return true;
end;
$$;

-- Same body as 0031 (insert columns unchanged, so 0043's before-insert refund
-- trigger still applies), plus: deleted / suspended referrers and FLAGGED
-- referrals earn nothing.
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
  v_flagged boolean;
  v_affiliate_status text;
  v_deleted boolean;
  v_suspended boolean;
  v_intro_rate numeric;
  v_lifetime_rate numeric;
  v_rate numeric;
begin
  if p_gross_amount is null or p_gross_amount <= 0 then
    return;
  end if;

  select referrer_id, referred_user_id, created_at, flagged
    into v_referrer_id, v_referred_id, v_created_at, v_flagged
  from public.referrals where id = p_referral_id;

  if v_referrer_id is null or coalesce(v_flagged, false) then
    return;
  end if;

  select affiliate_status,
         coalesce(affiliate_commission_rate, 0.30),
         coalesce(affiliate_commission_rate_lifetime, 0.15),
         is_deleted, is_suspended
    into v_affiliate_status, v_intro_rate, v_lifetime_rate, v_deleted, v_suspended
  from public.profiles where id = v_referrer_id;

  if v_affiliate_status is distinct from 'approved'
     or coalesce(v_deleted, false) or coalesce(v_suspended, false) then
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

create or replace function public.clear_referral_flag(p_referral_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  update public.referrals set flagged = false, flag_reason = null
  where id = p_referral_id and flagged = true
  returning id into v_id;
  return v_id is not null;
end;
$$;

-- ── 6. Cancel a pending payout ───────────────────────────────
-- 0043's run_affiliate_payout_cycle inserts with ON CONFLICT (referrer_id,
-- cycle_start, cycle_end), so that unique constraint must stay — which means a
-- cancelled payout can't be left behind as a 'void' row (it would block the
-- cycle from ever being re-run for that affiliate). Instead: release the
-- commissions, DELETE the row, and hand the details back so the route can
-- record them in admin_audit_log.
create or replace function public.void_affiliate_payout(p_payout_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p public.affiliate_payouts%rowtype;
  v_released integer;
begin
  select * into p from public.affiliate_payouts where id = p_payout_id and status = 'pending' for update;
  if not found then
    return null;
  end if;

  update public.affiliate_commissions set payout_id = null where payout_id = p.id and status = 'pending';
  get diagnostics v_released = row_count;
  delete from public.affiliate_payouts where id = p.id;

  return jsonb_build_object(
    'referrer_id', p.referrer_id, 'cycle_start', p.cycle_start, 'cycle_end', p.cycle_end,
    'amount_usd', p.amount_usd, 'payout_method', p.payout_method, 'commissions_released', v_released
  );
end;
$$;

-- ── 8. Account deletion scrub (B9) ───────────────────────────

create or replace function public.scrub_affiliate_data(p_user_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.profiles
  set payout_method = null,
      payout_wallet_address = null,
      payout_wallet_network = null,
      payout_bank_details = null,
      payout_mpesa_phone = null,
      payout_method_updated_at = null,
      affiliate_application = null,
      reseller_application = null,
      api_access_application = null,
      company_name = null,
      affiliate_status = case when affiliate_status is null then null else 'suspended' end
  where id = p_user_id;

  -- Unbatched earnings are forfeited with the account. Batched/paid payout
  -- rows are kept (financial record).
  update public.affiliate_commissions
  set status = 'void'
  where referrer_id = p_user_id and payout_id is null and status = 'pending';
end;
$$;

-- ── 9. Resellers ─────────────────────────────────────────────

create or replace function public.allocate_reseller_bandwidth_tx(
  p_reseller_id  uuid,
  p_recipient_id uuid,
  p_gb           numeric,
  p_note         text default null
)
returns table (new_reseller_allocated_gb numeric, transfer_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_updated_allocated numeric;
  v_transfer uuid;
begin
  if p_gb is null or p_gb < 0.1 then
    raise exception 'Minimum allocation is 0.1 GB';
  end if;
  if p_gb <> round(p_gb, 3) then
    raise exception 'At most 3 decimal places are allowed';
  end if;
  if p_gb > 1000000 then
    raise exception 'Amount too large';
  end if;
  if p_reseller_id = p_recipient_id then
    raise exception 'Cannot allocate bandwidth to yourself';
  end if;

  -- Same lock order everywhere (see reclaim_reseller_allocation) → no deadlocks.
  perform 1 from public.bandwidth_accounts
  where user_id in (p_reseller_id, p_recipient_id) order by user_id for update;

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

  insert into public.reseller_transfers (reseller_id, recipient_id, gb_amount, status, activated_at, note)
  values (p_reseller_id, p_recipient_id, p_gb, 'active', now(), nullif(left(trim(coalesce(p_note, '')), 200), ''))
  returning id into v_transfer;

  return query select v_updated_allocated, v_transfer;
end;
$$;

drop function if exists public.reclaim_reseller_allocation(uuid, uuid, numeric);

create or replace function public.reclaim_reseller_allocation(
  p_transfer_id uuid,
  p_reseller_id uuid,
  p_gb          numeric default null
)
returns table (out_reclaimed_gb numeric, out_remaining_gb numeric)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  t public.reseller_transfers%rowtype;
  v_remaining numeric;
  v_avail numeric;
  v_amount numeric;
begin
  select * into t from public.reseller_transfers
  where id = p_transfer_id and reseller_id = p_reseller_id for update;
  if not found then
    raise exception 'Transfer not found';
  end if;
  if t.status <> 'active' then
    raise exception 'Nothing left to reclaim on this transfer';
  end if;

  perform 1 from public.bandwidth_accounts
  where user_id in (t.reseller_id, t.recipient_id) order by user_id for update;

  v_remaining := t.gb_amount - t.reclaimed_gb;
  select greatest(coalesce(available_gb, 0), 0) into v_avail
  from public.bandwidth_accounts where user_id = t.recipient_id;
  v_avail := coalesce(v_avail, 0);

  v_amount := least(v_remaining, v_avail);
  if p_gb is not null then
    v_amount := least(v_amount, p_gb);
  end if;
  v_amount := round(v_amount, 3);

  if v_amount <= 0 then
    raise exception 'Nothing to reclaim — the client has already used or committed this bandwidth.';
  end if;

  update public.bandwidth_accounts set total_gb = total_gb - v_amount where user_id = t.recipient_id;
  update public.bandwidth_accounts set allocated_gb = greatest(allocated_gb - v_amount, 0) where user_id = t.reseller_id;

  update public.reseller_transfers
  set reclaimed_gb = reclaimed_gb + v_amount,
      status = case when reclaimed_gb + v_amount >= gb_amount then 'reclaimed' else status end
  where id = t.id;

  return query select v_amount, v_remaining - v_amount;
end;
$$;

create or replace function public.reseller_client_roster(
  p_reseller_id uuid,
  p_search      text default null,
  p_limit       integer default 25,
  p_offset      integer default 0
)
returns table (
  client_id           uuid,
  email               text,
  full_name           text,
  is_deleted          boolean,
  is_suspended        boolean,
  transfer_count      bigint,
  total_received_gb   numeric,
  total_reclaimed_gb  numeric,
  last_transfer_at    timestamptz,
  last_note           text,
  client_total_gb     numeric,
  client_used_gb      numeric,
  client_available_gb numeric,
  total_count         bigint
) language sql stable security definer set search_path = public, pg_temp as $$
  with agg as (
    select rt.recipient_id,
           count(*) as cnt,
           sum(rt.gb_amount) as recv,
           sum(rt.reclaimed_gb) as recl,
           max(rt.created_at) as last_at,
           (array_agg(rt.note order by rt.created_at desc) filter (where rt.note is not null))[1] as last_note
    from public.reseller_transfers rt
    where rt.reseller_id = p_reseller_id
    group by rt.recipient_id
  )
  select a.recipient_id, p.email, p.full_name,
         coalesce(p.is_deleted, false), coalesce(p.is_suspended, false),
         a.cnt, a.recv, a.recl, a.last_at, a.last_note,
         b.total_gb, b.used_gb, b.available_gb,
         count(*) over ()
  from agg a
  join public.profiles p on p.id = a.recipient_id
  left join public.bandwidth_accounts b on b.user_id = a.recipient_id
  where p_search is null or p_search = ''
     or p.email ilike '%' || replace(replace(p_search, '%', '\%'), '_', '\_') || '%'
     or p.full_name ilike '%' || replace(replace(p_search, '%', '\%'), '_', '\_') || '%'
  order by a.last_at desc
  limit least(greatest(p_limit, 1), 100) offset greatest(p_offset, 0);
$$;

drop function if exists public.reseller_summary(uuid);

create or replace function public.reseller_summary(p_reseller_id uuid)
returns table (
  total_allocated_gb numeric,
  total_reclaimed_gb numeric,
  transfer_count     bigint,
  client_count       bigint,
  clients_used_gb    numeric -- consumed across all of this reseller's clients' own accounts
) language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(rt.gb_amount), 0),
         coalesce(sum(rt.reclaimed_gb), 0),
         count(*),
         count(distinct rt.recipient_id),
         coalesce((
           select sum(b.used_gb) from public.bandwidth_accounts b
           where b.user_id in (select distinct recipient_id from public.reseller_transfers where reseller_id = p_reseller_id)
         ), 0)
  from public.reseller_transfers rt where rt.reseller_id = p_reseller_id;
$$;

-- ── 10. Affiliate-facing summary / funnel / clicks ───────────
-- Service-role only (the app convention since 0042): the dashboard page calls
-- these through the admin client with the SESSION's user id — nothing here is
-- reachable from a browser.

create or replace function public.record_referral_click(p_code text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  select id into v_id from public.profiles
  where referral_code = upper(trim(coalesce(p_code, ''))) and not coalesce(is_deleted, false);
  if v_id is null then return; end if;
  insert into public.referral_clicks (referrer_id, day, clicks)
  values (v_id, (now() at time zone 'UTC')::date, 1)
  on conflict (referrer_id, day) do update set clicks = public.referral_clicks.clicks + 1;
end;
$$;

drop function if exists public.my_affiliate_summary(date, date);
drop function if exists public.my_affiliate_summary(uuid, date, date);

create or replace function public.my_affiliate_summary(p_user_id uuid, p_cycle_start date, p_cycle_end date)
returns table (
  accruing_usd    numeric, -- pending, not yet batched into a payout
  in_payout_usd   numeric, -- batched, awaiting payment
  paid_usd        numeric,
  this_cycle_usd  numeric,
  referral_count  bigint,
  converted_count bigint,
  flagged_count   bigint,
  clicks_total    bigint,
  bonus_gb_total  numeric -- standard (non-affiliate) GB bonuses credited to this user
) language sql stable security definer set search_path = public, pg_temp as $$
  select
    coalesce(sum(case when c.status = 'pending' and c.payout_id is null then c.commission_amount_usd end), 0),
    coalesce(sum(case when c.status = 'pending' and c.payout_id is not null then c.commission_amount_usd end), 0),
    coalesce(sum(case when c.status = 'paid' then c.commission_amount_usd end), 0),
    coalesce(sum(case when c.status <> 'void'
                        and (c.created_at at time zone 'UTC')::date between p_cycle_start and p_cycle_end
                      then c.commission_amount_usd end), 0),
    (select count(*) from public.referrals where referrer_id = p_user_id),
    (select count(*) from public.referrals r where r.referrer_id = p_user_id
        and (r.gb_bonus_credited_at is not null
             or exists (select 1 from public.affiliate_commissions x where x.referral_id = r.id))),
    (select count(*) from public.referrals where referrer_id = p_user_id and flagged),
    (select coalesce(sum(clicks), 0) from public.referral_clicks where referrer_id = p_user_id),
    (select coalesce(sum(gb_bonus_amount), 0) from public.referrals where referrer_id = p_user_id and gb_bonus_credited_at is not null)
  from public.affiliate_commissions c
  where c.referrer_id = p_user_id;
$$;

drop function if exists public.my_referral_funnel(integer, integer);


create or replace function public.my_referral_funnel(p_user_id uuid, p_limit integer default 25, p_offset integer default 0)
returns table (
  referred_label  text,
  joined_at       timestamptz,
  sub_id          text,
  flagged         boolean,
  bonus_credited  boolean,
  first_purchase_at timestamptz,
  orders_count    bigint,
  earned_usd      numeric,
  total_count     bigint
) language sql stable security definer set search_path = public, pg_temp as $$
  select
    case when coalesce(p.is_deleted, false) then 'deleted account'
         else left(split_part(p.email, '@', 1), 1) || '***@' || left(split_part(p.email, '@', 2), 1) || '***'
              || coalesce(substring(split_part(p.email, '@', 2) from '\.[^.]+$'), '') end,
    r.created_at,
    r.sub_id,
    r.flagged,
    r.gb_bonus_credited_at is not null,
    (select min(o.paid_at) from public.orders o where o.user_id = r.referred_user_id and o.bandwidth_credited and not coalesce(o.is_canary, false)),
    (select count(*) from public.orders o where o.user_id = r.referred_user_id and o.bandwidth_credited and not coalesce(o.is_canary, false)),
    (select coalesce(sum(c.commission_amount_usd), 0) from public.affiliate_commissions c where c.referral_id = r.id and c.status <> 'void'),
    count(*) over ()
  from public.referrals r
  join public.profiles p on p.id = r.referred_user_id
  where r.referrer_id = p_user_id
  order by r.created_at desc
  limit least(greatest(p_limit, 1), 100) offset greatest(p_offset, 0);
$$;

-- ── 12b. Email change restarts the payout hold ──────────────
-- An email change is step one of an account takeover. Same trigger as before
-- (the ONLY path allowed to move profiles.email), now also restarting the
-- payout-method hold for accounts that have one.
create or replace function public.sync_profile_email()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.email is distinct from old.email then
    update public.profiles
    set email = new.email,
        updated_at = now(),
        payout_method_updated_at = case when payout_method is not null then now() else payout_method_updated_at end
    where id = new.id;
  end if;
  return new;
end;
$$;

-- ── 12c. Account-security events restart the payout hold ─────
-- The 48h hold on a changed payout method only protects anyone if every
-- account-takeover step restarts it, not just editing the method. Upstream's
-- security_events table (0039_auth_mfa_hardening) records each of these however
-- they happen (DB trigger for password changes, app code for the rest), so one
-- trigger here covers every path — including ones added later.
create or replace function public.bump_payout_hold_on_security_event()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.event in ('password_changed', 'email_change_requested', 'mfa_disabled',
                   'mfa_reset_by_admin', 'mfa_backup_regenerated') then
    update public.profiles
    set payout_method_updated_at = now()
    where id = new.user_id and payout_method is not null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_bump_payout_hold on public.security_events;
create trigger trg_bump_payout_hold
  after insert on public.security_events
  for each row execute function public.bump_payout_hold_on_security_event();

revoke all on function public.bump_payout_hold_on_security_event() from public, anon, authenticated;

-- ── 13. Grants ───────────────────────────────────────────────
-- Everything here is service-role only (the convention since 0042): the
-- dashboard / admin routes call these through the admin client with an
-- explicit user id. Nothing is reachable from a browser.
do $$
declare
  f text;
begin
  foreach f in array array[
    'normalize_email_alias(text)',
    'record_referral_signup(text, uuid, text, text)',
    'claim_referral_code(text, uuid, text, text)',
    'credit_referral_bonus(uuid, numeric, numeric, numeric)',
    'record_affiliate_commission(uuid, uuid, numeric)',
    'clear_referral_flag(uuid)',
    'void_affiliate_payout(uuid)',
    'scrub_affiliate_data(uuid)',
    'allocate_reseller_bandwidth_tx(uuid, uuid, numeric, text)',
    'reclaim_reseller_allocation(uuid, uuid, numeric)',
    'reseller_client_roster(uuid, text, integer, integer)',
    'reseller_summary(uuid)',
    'record_referral_click(text)',
    'my_affiliate_summary(uuid, date, date)',
    'my_referral_funnel(uuid, integer, integer)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

insert into public.schema_migrations (filename) values
  ('0044_section7_affiliates_resellers_hardening.sql')
on conflict do nothing;

-- ============================================================
-- 0045_auth_mfa_closeout.sql (folded)
-- ============================================================
-- 0045_auth_mfa_closeout.sql
-- Section 2 (Auth & MFA) close-out round.
--
--  A. Atomic MFA enrollment / backup-code regeneration, per-user unique
--     backup-code hashes, guarded start-enrollment, last-slot lock refund.
--  B. Trusted-browser metadata on mfa_verified_sessions.
--  C. Per-account login throttle (auth_throttle).
--  D. Pre-hijack fix support: auth_unconfirmed_user_id(); password-change
--     trigger ignores unconfirmed accounts.
--  E. Email-change trigger -> security event (notice goes to the OLD address).
--  F. Signup policy enforced IN THE DATABASE (before insert on auth.users):
--     ban list (plus-address aware) + disposable domains. A direct GoTrue
--     signup with the public anon key can no longer skip it.
--  G. Active-session list / revoke helpers over auth.sessions.
--  H. Self-service "lost my authenticator" recovery with a waiting period.
--  I. cleanup_old_security_events() also sweeps throttle + recovery rows.
--  J. The payout-hold trigger from 0044 also fires on email_changed and
--     mfa_recovery_completed.
--
-- Every function below is SECURITY DEFINER with a pinned search_path and is
-- executable by service_role only.

-- ── A. MFA atomicity ───────────────────────────────────────────────
drop index if exists public.mfa_backup_codes_hash_idx;
create unique index if not exists mfa_backup_codes_user_hash_idx
  on public.mfa_backup_codes(user_id, code_hash);

create or replace function public.mfa_replace_backup_codes(p_user_id uuid, p_hashes text[])
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Serialise concurrent regenerations for the same user.
  perform 1 from public.mfa_totp_factors where user_id = p_user_id for update;
  if not found then
    raise exception 'No MFA factor for this account.' using errcode = 'P0002';
  end if;
  delete from public.mfa_backup_codes where user_id = p_user_id and used_at is null;
  insert into public.mfa_backup_codes (user_id, code_hash)
    select p_user_id, h from unnest(p_hashes) as h;
end;
$$;

create or replace function public.confirm_totp_enrollment_atomic(
  p_user_id uuid, p_used_counter integer, p_hashes text[]
)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_confirmed boolean;
begin
  select confirmed into v_confirmed from public.mfa_totp_factors where user_id = p_user_id for update;
  if not found then
    raise exception 'No pending MFA enrollment found for this account.' using errcode = 'P0002';
  end if;
  if v_confirmed then
    raise exception 'MFA is already enabled for this account.' using errcode = 'P0001';
  end if;

  update public.mfa_totp_factors
    set confirmed = true, confirmed_at = now(), failed_attempts = 0, locked_until = null,
        last_used_at = now(), last_used_counter = p_used_counter
    where user_id = p_user_id;
  update public.profiles set mfa_enabled = true where id = p_user_id;

  delete from public.mfa_backup_codes where user_id = p_user_id and used_at is null;
  insert into public.mfa_backup_codes (user_id, code_hash)
    select p_user_id, h from unnest(p_hashes) as h;
end;
$$;

-- Returns false (and changes nothing) when the factor is already confirmed.
create or replace function public.mfa_start_enrollment(p_user_id uuid, p_secret text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_rows integer;
begin
  insert into public.mfa_totp_factors (user_id, secret, confirmed, last_used_counter)
  values (p_user_id, p_secret, false, null)
  on conflict (user_id) do update
    set secret = excluded.secret, confirmed = false, last_used_counter = null, created_at = now()
    where public.mfa_totp_factors.confirmed = false;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- Refund now understands the "last slot" reservation: mfa_begin_attempt
-- locks the factor on the 5th reservation, so an infrastructure error on
-- that attempt must lift the lock again.
drop function if exists public.mfa_refund_attempt(uuid);
create or replace function public.mfa_refund_attempt(
  p_user_id uuid, p_was_last boolean default false, p_max integer default 5
)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_was_last then
    update public.mfa_totp_factors
      set failed_attempts = greatest(p_max - 1, 0), locked_until = null
      where user_id = p_user_id and locked_until is not null and locked_until > now();
  else
    update public.mfa_totp_factors
      set failed_attempts = greatest(failed_attempts - 1, 0)
      where user_id = p_user_id and failed_attempts > 0;
  end if;
end;
$$;

-- ── B. Trusted-browser metadata ────────────────────────────────────
alter table public.mfa_verified_sessions
  add column if not exists remembered boolean not null default false,
  add column if not exists user_agent text,
  add column if not exists ip text;

-- ── C. Per-account login throttle ──────────────────────────────────
create table if not exists public.auth_throttle (
  key          text primary key,            -- sha-256 of the lower-cased email
  hits         integer not null default 0,
  window_start timestamptz not null default now(),
  notified     boolean not null default false
);
alter table public.auth_throttle enable row level security;

-- Counts one attempt. Returns 'ok', 'blocked_first' (first block in this
-- window — the caller sends the owner one alert) or 'blocked'.
create or replace function public.auth_throttle_hit(p_key text, p_max integer, p_window_s integer)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare r record;
begin
  insert into public.auth_throttle as t (key, hits, window_start)
  values (p_key, 1, now())
  on conflict (key) do update set
    hits = case when t.window_start < now() - make_interval(secs => p_window_s) then 1 else t.hits + 1 end,
    notified = case when t.window_start < now() - make_interval(secs => p_window_s) then false else t.notified end,
    window_start = case when t.window_start < now() - make_interval(secs => p_window_s) then now() else t.window_start end
  returning t.hits, t.notified into r;

  if r.hits <= p_max then return 'ok'; end if;
  if not r.notified then
    update public.auth_throttle set notified = true where key = p_key;
    return 'blocked_first';
  end if;
  return 'blocked';
end;
$$;

create or replace function public.auth_throttle_clear(p_key text)
returns void language sql security definer set search_path = public, pg_temp as $$
  delete from public.auth_throttle where key = p_key;
$$;

-- ── D. Pre-hijack support ──────────────────────────────────────────
create or replace function public.auth_unconfirmed_user_id(check_email text)
returns uuid language sql stable security definer set search_path = public as $$
  select id from auth.users
  where lower(email) = lower(check_email)
    and email_confirmed_at is null
    and (banned_until is null or banned_until < now())
  limit 1;
$$;

-- Replacing the password of an UNCONFIRMED account (a new signup for the
-- same address) is not a "password changed" event: nobody has signed in yet.
create or replace function public.on_auth_password_changed()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.encrypted_password is distinct from old.encrypted_password
     and old.encrypted_password is not null
     and new.email_confirmed_at is not null then
    delete from public.mfa_verified_sessions where user_id = new.id;
    insert into public.security_events (user_id, event, notify, meta)
    select new.id, 'password_changed', true, jsonb_build_object('source', 'db_trigger')
    where exists (select 1 from public.profiles where id = new.id);
  end if;
  return new;
end;
$$;

-- ── E. Email-change completed -> event (+ notice to the old address) ──
create or replace function public.on_auth_email_changed()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.email is distinct from old.email
     and old.email is not null
     and old.email_confirmed_at is not null then
    insert into public.security_events (user_id, event, notify, meta)
    select new.id, 'email_changed', true,
           jsonb_build_object(
             'old_email', old.email,
             'new_email_masked', left(split_part(new.email, '@', 1), 1) || '***@' || split_part(new.email, '@', 2)
           )
    where exists (select 1 from public.profiles where id = new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute procedure public.on_auth_email_changed();

-- ── F. Signup policy in the database ───────────────────────────────
create table if not exists public.disposable_email_domains (
  domain text primary key
);
alter table public.disposable_email_domains enable row level security;

insert into public.disposable_email_domains (domain) values
  ('10minutemail.co.uk'),
  ('10minutemail.com'),
  ('10minutemail.net'),
  ('1secmail.com'),
  ('1secmail.net'),
  ('1secmail.org'),
  ('20minutemail.com'),
  ('anonbox.net'),
  ('burnermail.io'),
  ('cs.email'),
  ('discard.email'),
  ('dispostable.com'),
  ('dropmail.me'),
  ('emailfake.com'),
  ('emailondeck.com'),
  ('emltmp.com'),
  ('fakeinbox.com'),
  ('fakemailgenerator.com'),
  ('filzmail.com'),
  ('getairmail.com'),
  ('getnada.com'),
  ('gmailnator.com'),
  ('grr.la'),
  ('guerrillamail.biz'),
  ('guerrillamail.com'),
  ('guerrillamail.de'),
  ('guerrillamail.info'),
  ('guerrillamail.net'),
  ('guerrillamail.org'),
  ('guerrillamailblock.com'),
  ('harakirimail.com'),
  ('inboxkitten.com'),
  ('incognitomail.org'),
  ('jetable.org'),
  ('linshiyouxiang.net'),
  ('luxusmail.org'),
  ('mail-temp.com'),
  ('mail.tm'),
  ('mailcatch.com'),
  ('maildax.me'),
  ('maildrop.cc'),
  ('mailforspam.com'),
  ('mailinator.com'),
  ('mailnesia.com'),
  ('mailnull.com'),
  ('mailpoof.com'),
  ('mailsac.com'),
  ('mailtemp.info'),
  ('mintemail.com'),
  ('minuteinbox.com'),
  ('moakt.com'),
  ('mohmal.com'),
  ('mytemp.email'),
  ('nada.email'),
  ('nowmymail.com'),
  ('pokemail.net'),
  ('pookmail.com'),
  ('sharklasers.com'),
  ('spam4.me'),
  ('spambox.us'),
  ('spamex.com'),
  ('spamgourmet.com'),
  ('spamoff.de'),
  ('temp-mail.io'),
  ('temp-mail.org'),
  ('tempail.com'),
  ('tempinbox.com'),
  ('tempmail.com'),
  ('tempmail.net'),
  ('tempmail.org'),
  ('tempmailo.com'),
  ('tempr.email'),
  ('throwam.com'),
  ('throwaway.email'),
  ('throwawaymail.com'),
  ('tmail.ws'),
  ('tmpmail.net'),
  ('tmpmail.org'),
  ('trash-mail.com'),
  ('trashmail.com'),
  ('trashmail.de'),
  ('trashmail.me'),
  ('trashmail.net'),
  ('trbvm.com'),
  ('wegwerfadresse.de'),
  ('wegwerfemail.de'),
  ('wh4f.org'),
  ('yopmail.com'),
  ('yopmail.fr'),
  ('yopmail.net')
on conflict do nothing;

create or replace function public.normalize_ban_email(p text)
returns text language sql immutable as $$
  select lower(regexp_replace(split_part(trim(p), '@', 1), '\+.*$', '')) || '@' || lower(split_part(trim(p), '@', 2));
$$;

create index if not exists banned_emails_normalized_idx
  on public.banned_emails (public.normalize_ban_email(email));

create or replace function public.is_email_banned(check_email text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.banned_emails b
    where public.normalize_ban_email(b.email) = public.normalize_ban_email(check_email)
  );
$$;

create or replace function public.enforce_signup_policy()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_domain text;
begin
  if new.email is null then return new; end if;
  v_domain := lower(split_part(new.email, '@', 2));

  if public.is_email_banned(new.email) then
    raise exception 'This email address cannot be used to register.' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.disposable_email_domains d
    where v_domain = d.domain or v_domain like '%.' || d.domain
  ) then
    raise exception 'Disposable email addresses are not allowed.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_signup_policy on auth.users;
create trigger enforce_signup_policy
  before insert on auth.users
  for each row execute procedure public.enforce_signup_policy();

-- ── G. Active-session helpers ──────────────────────────────────────
create or replace function public.list_auth_sessions(p_user_id uuid)
returns jsonb language sql stable security definer set search_path = public, auth, pg_temp as $$
  select coalesce(
    jsonb_agg(
      to_jsonb(s) - 'refresh_token_hmac_key' - 'refresh_token_counter' - 'factor_id' - 'oauth_client_id'
      order by s.updated_at desc nulls last
    ),
    '[]'::jsonb
  )
  from auth.sessions s
  where s.user_id = p_user_id;
$$;

create or replace function public.revoke_auth_session(p_user_id uuid, p_session_id uuid)
returns boolean language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare n integer;
begin
  delete from auth.sessions where id = p_session_id and user_id = p_user_id;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

-- ── H. Self-service MFA recovery (waiting period) ──────────────────
create table if not exists public.mfa_recovery_requests (
  id           uuid default uuid_generate_v4() primary key,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  token_hash   text not null unique,         -- sha-256 of the emailed token
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,         -- the emailed link is valid until here
  confirmed_at timestamptz,                  -- link opened + password re-entered: the clock starts
  ready_at     timestamptz,                  -- earliest moment the reset may complete
  cancelled_at timestamptz,
  completed_at timestamptz
);
create index if not exists mfa_recovery_requests_user_idx on public.mfa_recovery_requests(user_id, created_at desc);
alter table public.mfa_recovery_requests enable row level security;

-- ── I. Cleanup ─────────────────────────────────────────────────────
create or replace function public.cleanup_old_security_events()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_deleted integer;
begin
  delete from public.security_events where created_at < now() - interval '365 days';
  get diagnostics v_deleted = row_count;
  delete from public.auth_throttle where window_start < now() - interval '1 day';
  delete from public.mfa_recovery_requests where created_at < now() - interval '90 days';
  return v_deleted;
end;
$$;

-- ── J. Payout hold (0044 §12c) learns the new takeover steps ────
-- A completed email change and a completed 2FA recovery are exactly the
-- account-takeover steps the 48h payout-method hold exists for.
create or replace function public.bump_payout_hold_on_security_event()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.event in ('password_changed', 'email_change_requested', 'mfa_disabled',
                   'mfa_reset_by_admin', 'mfa_backup_regenerated',
                   'email_changed', 'mfa_recovery_completed') then
    update public.profiles
    set payout_method_updated_at = now()
    where id = new.user_id and payout_method is not null;
  end if;
  return new;
end;
$$;

-- ── Grants: service_role only ──────────────────────────────────────
revoke all on function public.mfa_replace_backup_codes(uuid, text[]) from public, anon, authenticated;
revoke all on function public.confirm_totp_enrollment_atomic(uuid, integer, text[]) from public, anon, authenticated;
revoke all on function public.mfa_start_enrollment(uuid, text) from public, anon, authenticated;
revoke all on function public.mfa_refund_attempt(uuid, boolean, integer) from public, anon, authenticated;
revoke all on function public.auth_throttle_hit(text, integer, integer) from public, anon, authenticated;
revoke all on function public.auth_throttle_clear(text) from public, anon, authenticated;
revoke all on function public.auth_unconfirmed_user_id(text) from public, anon, authenticated;
revoke all on function public.on_auth_email_changed() from public, anon, authenticated;
revoke all on function public.normalize_ban_email(text) from public, anon, authenticated;
revoke all on function public.is_email_banned(text) from public, anon, authenticated;
revoke all on function public.enforce_signup_policy() from public, anon, authenticated;
revoke all on function public.list_auth_sessions(uuid) from public, anon, authenticated;
revoke all on function public.revoke_auth_session(uuid, uuid) from public, anon, authenticated;
revoke all on function public.cleanup_old_security_events() from public, anon, authenticated;

grant execute on function public.mfa_replace_backup_codes(uuid, text[]) to service_role;
grant execute on function public.confirm_totp_enrollment_atomic(uuid, integer, text[]) to service_role;
grant execute on function public.mfa_start_enrollment(uuid, text) to service_role;
grant execute on function public.mfa_refund_attempt(uuid, boolean, integer) to service_role;
grant execute on function public.auth_throttle_hit(text, integer, integer) to service_role;
grant execute on function public.auth_throttle_clear(text) to service_role;
grant execute on function public.auth_unconfirmed_user_id(text) to service_role;
grant execute on function public.normalize_ban_email(text) to service_role;
grant execute on function public.is_email_banned(text) to service_role;
grant execute on function public.list_auth_sessions(uuid) to service_role;
grant execute on function public.revoke_auth_session(uuid, uuid) to service_role;
grant execute on function public.cleanup_old_security_events() to service_role;

insert into public.schema_migrations (filename) values
  ('0045_auth_mfa_closeout.sql')
on conflict do nothing;

-- ============================================================
-- Migration 0047 — payments & billing close-out (functions folded in above:
-- claim_and_credit_order, apply_order_refund, protect_order_columns)
-- ============================================================
-- ── 1/4. orders columns ─────────────────────────────────────
alter table public.orders add column if not exists billing_details jsonb;
alter table public.orders add column if not exists dispute_status text;
alter table public.orders add column if not exists dispute_opened_at timestamptz;
alter table public.orders add column if not exists dispute_resolution text;

alter table public.orders drop constraint if exists orders_dispute_status_check;
alter table public.orders add constraint orders_dispute_status_check
  check (dispute_status is null or dispute_status in ('open', 'resolved'));

create index if not exists orders_open_dispute_idx
  on public.orders (user_id) where dispute_status = 'open';

-- ── 3. profiles billing details ─────────────────────────────
alter table public.profiles add column if not exists billing_address text;
alter table public.profiles add column if not exists tax_id text;

alter table public.profiles drop constraint if exists profiles_billing_details_len;
alter table public.profiles add constraint profiles_billing_details_len
  check (char_length(coalesce(billing_address, '')) <= 500 and char_length(coalesce(tax_id, '')) <= 64);

-- ── 2. credit notes ─────────────────────────────────────────
create sequence if not exists public.credit_note_seq;
revoke all on sequence public.credit_note_seq from public, anon, authenticated;

alter table public.order_refunds add column if not exists credit_note_number text;

create unique index if not exists order_refunds_credit_note_key
  on public.order_refunds (credit_note_number) where credit_note_number is not null;

-- Customers may read refund rows of their own orders (invoice page). Writes
-- remain service-role only (no insert/update/delete policy).
drop policy if exists "Own order refunds" on public.order_refunds;
create policy "Own order refunds" on public.order_refunds for select
  using (exists (select 1 from public.orders o where o.id = order_refunds.order_id and o.user_id = auth.uid()));

-- The functions above were re-created; default privileges already keep new
-- SECURITY DEFINER functions off anon/authenticated (0042), restated here so
-- this migration is self-evidently safe on its own.
revoke all on function public.claim_and_credit_order(uuid, uuid, numeric, text) from public, anon, authenticated;
grant execute on function public.claim_and_credit_order(uuid, uuid, numeric, text) to service_role;
revoke all on function public.apply_order_refund(uuid, text, numeric) from public, anon, authenticated;
grant execute on function public.apply_order_refund(uuid, text, numeric) to service_role;

insert into public.schema_migrations (filename) values
  ('0047_payments_billing_closeout.sql')
on conflict do nothing;

-- ============================================================
-- Migration 0048 — M-Pesa checkout (protect_order_columns folded in above)
-- ============================================================
alter table public.orders add column if not exists pay_currency text not null default 'USD';
alter table public.orders add column if not exists pay_amount numeric;
alter table public.orders add column if not exists fx_rate numeric;

alter table public.orders drop constraint if exists orders_pay_currency_check;
alter table public.orders add constraint orders_pay_currency_check check (pay_currency in ('USD', 'KES'));
alter table public.orders drop constraint if exists orders_pay_amount_check;
alter table public.orders add constraint orders_pay_amount_check
  check ((pay_currency = 'USD' and pay_amount is null) or (pay_currency <> 'USD' and coalesce(pay_amount, 0) > 0 and coalesce(fx_rate, 0) > 0));

insert into public.platform_settings (key, value) values
  ('mpesa_enabled', 'true'),
  ('kes_fx_markup_pct', '2'),
  ('kes_fx_manual', ''),
  ('kes_fx_cache', '')
on conflict (key) do nothing;

insert into public.schema_migrations (filename) values
  ('0048_mpesa_checkout.sql')
on conflict do nothing;

-- last_provision_error is readable by the owning customer (SELECT on
-- proxy_credentials). Older rows could hold raw upstream-supplier error text.
-- Application code now writes only neutral codes; scrub what already exists.
update public.proxy_credentials
   set last_provision_error = 'provision_failed'
 where last_provision_error is not null
   and last_provision_error !~ '^(provision_failed|upstream_error_[0-9]+)$';

insert into public.schema_migrations (filename) values
  ('0049_dashboard_ui_closeout.sql')
on conflict do nothing;

-- ── 0050: Auth & MFA pass 2 ─────────────────────────────────────
create extension if not exists pgcrypto with schema extensions;

-- ── 2. password check in SQL ──────────────────────────────────────────
create or replace function public.auth_verify_password(p_user_id uuid, p_password text)
returns boolean
language plpgsql security definer set search_path = public, auth, extensions, pg_temp
as $$
declare v_hash text;
begin
  if p_password is null or p_password = '' then return false; end if;
  select encrypted_password into v_hash
    from auth.users
   where id = p_user_id and deleted_at is null;
  if v_hash is null or v_hash = '' then return false; end if;
  return extensions.crypt(p_password, v_hash) = v_hash;
end;
$$;

revoke all on function public.auth_verify_password(uuid, text) from public, anon, authenticated;
grant execute on function public.auth_verify_password(uuid, text) to service_role;

-- ── 3. conditional password replacement for unconfirmed accounts ──────
create or replace function public.auth_replace_unconfirmed_password(p_user_id uuid, p_password text)
returns boolean
language plpgsql security definer set search_path = public, auth, extensions, pg_temp
as $$
begin
  if p_password is null or length(p_password) < 1 then return false; end if;
  update auth.users
     set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
         updated_at = now()
   where id = p_user_id
     and email_confirmed_at is null
     and deleted_at is null;
  return found;
end;
$$;

revoke all on function public.auth_replace_unconfirmed_password(uuid, text) from public, anon, authenticated;
grant execute on function public.auth_replace_unconfirmed_password(uuid, text) to service_role;

-- ── 4. atomic recovery completion ─────────────────────────────────────
create or replace function public.mfa_complete_recovery(p_request_id uuid, p_user_id uuid, p_window interval)
returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  update public.mfa_recovery_requests
     set completed_at = now()
   where id = p_request_id
     and user_id = p_user_id
     and completed_at is null
     and cancelled_at is null
     and confirmed_at is not null
     and ready_at <= now()
     and ready_at + p_window > now()
  returning id into v_id;
  if v_id is null then return false; end if;
  -- Same transaction: if the wipe fails, the claim rolls back with it.
  perform public.wipe_mfa(p_user_id);
  return true;
end;
$$;

revoke all on function public.mfa_complete_recovery(uuid, uuid, interval) from public, anon, authenticated;
grant execute on function public.mfa_complete_recovery(uuid, uuid, interval) to service_role;

-- ── 5. revoke login sessions in bulk ──────────────────────────────────
-- Used after 2FA is removed (self-service recovery keeps the caller's own
-- session; an admin reset ends them all) so anyone else still signed in must
-- sign in again.
create or replace function public.revoke_other_auth_sessions(p_user_id uuid, p_keep uuid)
returns integer
language plpgsql security definer set search_path = public, auth, pg_temp
as $$
declare n integer;
begin
  delete from auth.sessions
   where user_id = p_user_id
     and (p_keep is null or id <> p_keep);
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.revoke_other_auth_sessions(uuid, uuid) from public, anon, authenticated;
grant execute on function public.revoke_other_auth_sessions(uuid, uuid) to service_role;

insert into public.schema_migrations (filename) values
  ('0050_auth_mfa_pass2.sql')
on conflict do nothing;

-- ============================================================
-- 0051_section7_reseller_affiliates_closeout.sql
-- ============================================================
-- ============================================================
-- 0051 — Reseller / referral / affiliate-payout close-out (section 7, audit pass 2)
-- ============================================================
-- Idempotent: safe to re-run. Apply AFTER 0048_mpesa_checkout.sql.
--
-- REFERRALS
--  * G1  The standard 1 GB referral bonus is now REVERSED when the order that
--        earned it is refunded below the minimum order value (or fully).
--        credit_referral_bonus() records which order earned it; a trigger on
--        orders claws the GB back from both sides (never below what is
--        actually unspent) and keeps the bonus "used up" so a second order
--        cannot re-earn it. Bonuses earned before this migration have no order
--        recorded and are left alone.
--  * G4  clear_referral_flag() now BACK-FILLS what the referral would have
--        earned while it was flagged (affiliate commissions at the rate that
--        applied when each order was paid, or the standard bonus), instead of
--        silently dropping those orders forever.
--  * G5  record_affiliate_commission() reports what it recorded (and whether
--        it is the referral's first commission) so the app can email the
--        referrer once per converted referral.
--
-- PAYOUTS
--  * B2  reseller_rejected_at / affiliate_rejected_at: the 7-day re-apply
--        cooldown is measured from the REVIEW, as promised, not from the
--        moment the application was submitted. Pinned by the profile-protection
--        trigger so a user cannot reset their own cooldown.
--  * B3  scrub_affiliate_data() also clears the payout-destination SNAPSHOTS
--        (bank / wallet / M-Pesa) stored on affiliate_payouts; amounts, dates
--        and payment references stay as the financial record. Accounts that
--        were already deleted are back-filled here.
--  * B5a A refund that shrinks a pending payout to $0 now removes the empty
--        payout (freeing the cycle slot) and leaves an audit-log row.
--
-- RESELLERS
--  * B1  reclaim_reseller_allocation() can no longer take bandwidth the client
--        bought / earned themselves: only the part of a transfer that is still
--        unspent after everything the client received LATER is reclaimable
--        (oldest-first consumption), within a 30-day window.
--  * B5d reseller_client_roster() / reseller_summary() only report usage of the
--        GB THIS reseller sent, not the client's whole account.
-- ============================================================

-- ── 1. Columns ───────────────────────────────────────────────
alter table public.referrals add column if not exists gb_bonus_order_id    uuid references public.orders(id) on delete set null;
alter table public.referrals add column if not exists gb_bonus_min_usd     numeric;
alter table public.referrals add column if not exists gb_bonus_reversed_at timestamptz;
create index if not exists idx_referrals_bonus_order on public.referrals (gb_bonus_order_id) where gb_bonus_order_id is not null;

alter table public.profiles add column if not exists reseller_rejected_at  timestamptz;
alter table public.profiles add column if not exists affiliate_rejected_at timestamptz;

-- ── 2. protect_privileged_profile_columns (full body) ────────
-- Rebased on 0044's definition; the only additions are the two *_rejected_at
-- columns (a user must not be able to clear their own cooldown).
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
  new.email                              := old.email; -- see migration 0011
  new.affiliate_status                   := old.affiliate_status; -- see migration 0031
  new.affiliate_commission_rate          := old.affiliate_commission_rate;
  new.affiliate_commission_rate_lifetime := old.affiliate_commission_rate_lifetime;
  new.payout_method                      := old.payout_method; -- see migration 0034, extended by 0035
  new.payout_wallet_address              := old.payout_wallet_address;
  new.payout_wallet_network              := old.payout_wallet_network;
  new.payout_bank_details                := old.payout_bank_details;
  new.payout_mpesa_phone                 := old.payout_mpesa_phone;
  new.payout_method_updated_at           := old.payout_method_updated_at;
  new.is_verified_operator               := old.is_verified_operator; -- see migration 0037
  new.verified_operator_since            := old.verified_operator_since;
  new.verified_operator_prev_rate        := old.verified_operator_prev_rate; -- see migration 0043
  new.verified_operator_prev_rate_lifetime := old.verified_operator_prev_rate_lifetime;
  new.mfa_enabled                        := old.mfa_enabled; -- see migration 0039_auth_mfa_hardening
  new.referral_code                      := old.referral_code; -- migration 0044
  new.reseller_rejected_at               := old.reseller_rejected_at; -- migration 0051
  new.affiliate_rejected_at              := old.affiliate_rejected_at;

  return new;
end;
$$;

-- ── 3. Referral bonus: remember the order, reverse on refund (G1) ─
drop function if exists public.credit_referral_bonus(uuid, numeric, numeric, numeric);

create or replace function public.credit_referral_bonus(
  p_referral_id      uuid,
  p_gb               numeric,
  p_order_amount_usd numeric default null,
  p_min_order_usd    numeric default 0,
  p_order_id         uuid default null
)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_referrer_id uuid;
  v_referred_id uuid;
  v_claimed     uuid;
begin
  update public.referrals r
  set gb_bonus_credited_at = now(), gb_bonus_amount = p_gb,
      gb_bonus_order_id = p_order_id, gb_bonus_min_usd = p_min_order_usd
  from public.profiles pr
  where r.id = p_referral_id
    and r.gb_bonus_credited_at is null
    and r.flagged = false
    and pr.id = r.referrer_id
    and not coalesce(pr.is_deleted, false)
    and not coalesce(pr.is_suspended, false)
    and (p_order_amount_usd is null or p_order_amount_usd >= p_min_order_usd)
  returning r.id, r.referrer_id, r.referred_user_id into v_claimed, v_referrer_id, v_referred_id;

  if v_claimed is null then
    return false;
  end if;

  perform public.credit_bandwidth(v_referrer_id, p_gb);
  perform public.credit_bandwidth(v_referred_id, p_gb);
  return true;
end;
$$;

create or replace function public.reverse_referral_bonus_on_refund()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r         public.referrals%rowtype;
  v_net     numeric;
  v_avail   numeric;
  v_claw_a  numeric := 0; -- from the referrer
  v_claw_b  numeric := 0; -- from the referred user
begin
  if coalesce(new.refunded_usd, 0) <= coalesce(old.refunded_usd, 0) then
    return new;
  end if;

  select * into r from public.referrals
  where gb_bonus_order_id = new.id
    and gb_bonus_credited_at is not null
    and gb_bonus_reversed_at is null
  for update;
  if not found then
    return new;
  end if;

  -- Still a qualifying order after the refund → the bonus stands.
  v_net := coalesce(new.amount_usd, 0) - coalesce(new.refunded_usd, 0);
  if v_net > 0 and v_net >= coalesce(r.gb_bonus_min_usd, 0) then
    return new;
  end if;

  -- Same lock order as the reseller functions (by user_id).
  perform 1 from public.bandwidth_accounts
  where user_id in (r.referrer_id, r.referred_user_id) order by user_id for update;

  select greatest(coalesce(available_gb, 0), 0) into v_avail
  from public.bandwidth_accounts where user_id = r.referrer_id;
  v_claw_a := least(coalesce(r.gb_bonus_amount, 0), coalesce(v_avail, 0));
  if v_claw_a > 0 then
    update public.bandwidth_accounts set total_gb = total_gb - v_claw_a where user_id = r.referrer_id;
  end if;

  select greatest(coalesce(available_gb, 0), 0) into v_avail
  from public.bandwidth_accounts where user_id = r.referred_user_id;
  v_claw_b := least(coalesce(r.gb_bonus_amount, 0), coalesce(v_avail, 0));
  if v_claw_b > 0 then
    update public.bandwidth_accounts set total_gb = total_gb - v_claw_b where user_id = r.referred_user_id;
  end if;

  -- Stays "credited" (so a later order cannot re-earn it) but is marked reversed.
  update public.referrals set gb_bonus_reversed_at = now() where id = r.id;

  insert into public.admin_audit_log (admin_id, action, target_user_id, target_ref, details)
  values (null, 'referral_bonus_reversed', r.referrer_id, new.id::text,
          jsonb_build_object('referral_id', r.id, 'bonus_gb', r.gb_bonus_amount,
                             'clawed_from_referrer_gb', v_claw_a, 'clawed_from_referred_gb', v_claw_b,
                             'order_refunded_usd', new.refunded_usd, 'order_amount_usd', new.amount_usd));
  return new;
end;
$$;

drop trigger if exists trg_reverse_referral_bonus_on_refund on public.orders;
create trigger trg_reverse_referral_bonus_on_refund
  after update of refunded_usd on public.orders
  for each row execute function public.reverse_referral_bonus_on_refund();

-- ── 4. Commission: report what was recorded; rate window by earn time (G5/G4) ─
drop function if exists public.record_affiliate_commission(uuid, uuid, numeric);

create or replace function public.record_affiliate_commission(
  p_referral_id  uuid,
  p_order_id     uuid,
  p_gross_amount numeric,
  p_earned_at    timestamptz default null
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_referrer_id uuid;
  v_referred_id uuid;
  v_created_at timestamptz;
  v_flagged boolean;
  v_affiliate_status text;
  v_deleted boolean;
  v_suspended boolean;
  v_intro_rate numeric;
  v_lifetime_rate numeric;
  v_rate numeric;
  v_id uuid;
  v_amt numeric;
  v_first boolean;
begin
  if p_gross_amount is null or p_gross_amount <= 0 then
    return null;
  end if;

  select referrer_id, referred_user_id, created_at, flagged
    into v_referrer_id, v_referred_id, v_created_at, v_flagged
  from public.referrals where id = p_referral_id;

  if v_referrer_id is null or coalesce(v_flagged, false) then
    return null;
  end if;

  select affiliate_status,
         coalesce(affiliate_commission_rate, 0.30),
         coalesce(affiliate_commission_rate_lifetime, 0.15),
         is_deleted, is_suspended
    into v_affiliate_status, v_intro_rate, v_lifetime_rate, v_deleted, v_suspended
  from public.profiles where id = v_referrer_id;

  if v_affiliate_status is distinct from 'approved'
     or coalesce(v_deleted, false) or coalesce(v_suspended, false) then
    return null;
  end if;

  v_rate := case when coalesce(p_earned_at, now()) <= v_created_at + interval '90 days' then v_intro_rate else v_lifetime_rate end;

  insert into public.affiliate_commissions
    (referral_id, referrer_id, referred_user_id, order_id, gross_amount_usd, commission_rate, commission_amount_usd)
  values
    (p_referral_id, v_referrer_id, v_referred_id, p_order_id, p_gross_amount, v_rate, round(p_gross_amount * v_rate, 2))
  on conflict (order_id) do nothing
  returning id, commission_amount_usd into v_id, v_amt;

  if v_id is null then
    return null; -- already recorded for this order
  end if;

  v_first := not exists (
    select 1 from public.affiliate_commissions where referral_id = p_referral_id and id <> v_id
  );
  return jsonb_build_object('commission_usd', v_amt, 'rate', v_rate, 'first', v_first);
end;
$$;

-- ── 5. Clearing a flag back-fills what was held back (G4) ────
drop function if exists public.clear_referral_flag(uuid);

create or replace function public.clear_referral_flag(
  p_referral_id   uuid,
  p_gb            numeric default 1,
  p_min_order_usd numeric default 5
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r              public.referrals%rowtype;
  v_status       text;
  o              record;
  v_res          jsonb;
  v_count        integer := 0;
  v_total        numeric := 0;
  v_bonus        boolean := false;
begin
  update public.referrals set flagged = false, flag_reason = null
  where id = p_referral_id and flagged = true
  returning * into r;
  if not found then
    return null;
  end if;

  select affiliate_status into v_status from public.profiles where id = r.referrer_id;

  for o in
    select id, amount_usd, coalesce(refunded_usd, 0) as refunded_usd, coalesce(paid_at, created_at) as earned_at
    from public.orders
    where user_id = r.referred_user_id
      and bandwidth_credited = true
      and coalesce(is_canary, false) = false
    order by coalesce(paid_at, created_at), created_at
  loop
    if v_status = 'approved' then
      v_res := public.record_affiliate_commission(r.id, o.id, o.amount_usd, o.earned_at);
      if v_res is not null then
        v_count := v_count + 1;
        v_total := v_total + (v_res->>'commission_usd')::numeric;
      end if;
    elsif v_status is distinct from 'suspended' and not v_bonus then
      if public.credit_referral_bonus(r.id, p_gb, o.amount_usd - o.refunded_usd, p_min_order_usd, o.id) then
        v_bonus := true;
      end if;
    end if;
  end loop;

  return jsonb_build_object('commissions_backfilled', v_count, 'commission_usd', v_total, 'bonus_credited', v_bonus);
end;
$$;

-- ── 6. Refund that empties a pending payout (B5a) ────────────
create or replace function public.reduce_commission_on_refund()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c record;
  v_ratio numeric;
  v_new numeric;
  v_delta numeric;
  v_payout_amt numeric;
begin
  if coalesce(new.refunded_usd, 0) <= coalesce(old.refunded_usd, 0) or coalesce(new.amount_usd, 0) <= 0 then
    return new;
  end if;

  v_ratio := least(new.refunded_usd / new.amount_usd, 1);

  select * into c from public.affiliate_commissions where order_id = new.id for update;
  if not found then
    return new;
  end if;

  if c.status = 'paid' then
    -- Already paid out — cannot be clawed back automatically. Leave a
    -- trail so an admin can follow up with the affiliate.
    insert into public.admin_audit_log (admin_id, action, target_user_id, target_ref, details)
    values (null, 'commission_refund_after_paid', c.referrer_id, new.id::text,
            jsonb_build_object('commission_id', c.id, 'commission_amount_usd', c.commission_amount_usd,
                               'order_refunded_usd', new.refunded_usd, 'order_amount_usd', new.amount_usd));
    return new;
  end if;

  if c.status <> 'pending' then
    return new; -- void already
  end if;

  v_new := case when v_ratio >= 1 then 0
                else round(c.gross_amount_usd * (1 - v_ratio) * c.commission_rate, 2) end;
  v_delta := c.commission_amount_usd - v_new;
  if v_delta <= 0 then
    return new;
  end if;

  update public.affiliate_commissions
  set commission_amount_usd = v_new,
      status = case when v_new = 0 then 'void' else status end
  where id = c.id;

  if c.payout_id is not null then
    update public.affiliate_payouts
    set amount_usd = greatest(amount_usd - v_delta, 0)
    where id = c.payout_id and status = 'pending'
    returning amount_usd into v_payout_amt;

    -- Nothing left to pay: drop the empty payout (the FK nulls the link on any
    -- remaining commission rows) so it can't be "marked paid" for $0 and the
    -- (referrer, cycle) slot is free again.
    if found and v_payout_amt <= 0 then
      delete from public.affiliate_payouts where id = c.payout_id;
      insert into public.admin_audit_log (admin_id, action, target_user_id, target_ref, details)
      values (null, 'payout_emptied_by_refund', c.referrer_id, c.payout_id::text,
              jsonb_build_object('order_id', new.id, 'order_refunded_usd', new.refunded_usd));
    end if;
  end if;

  return new;
end;
$$;

-- ── 7. Account deletion: scrub payout destination snapshots (B3) ─
create or replace function public.scrub_affiliate_data(p_user_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.profiles
  set payout_method = null,
      payout_wallet_address = null,
      payout_wallet_network = null,
      payout_bank_details = null,
      payout_mpesa_phone = null,
      payout_method_updated_at = null,
      affiliate_application = null,
      reseller_application = null,
      api_access_application = null,
      company_name = null,
      affiliate_status = case when affiliate_status is null then null else 'suspended' end
  where id = p_user_id;

  -- Unbatched earnings are forfeited with the account. Batched/paid payout
  -- rows are kept (financial record) — but WITHOUT the destination snapshot:
  -- bank / wallet / phone details are personal data with no accounting value.
  update public.affiliate_commissions
  set status = 'void'
  where referrer_id = p_user_id and payout_id is null and status = 'pending';

  update public.affiliate_payouts
  set payout_wallet_address = null,
      payout_wallet_network = null,
      payout_bank_details = null,
      payout_mpesa_phone = null
  where referrer_id = p_user_id
    and (payout_wallet_address is not null or payout_wallet_network is not null
         or payout_bank_details is not null or payout_mpesa_phone is not null);
end;
$$;

-- One-time clean-up for accounts deleted before this migration.
update public.affiliate_payouts p
set payout_wallet_address = null,
    payout_wallet_network = null,
    payout_bank_details = null,
    payout_mpesa_phone = null
from public.profiles pr
where pr.id = p.referrer_id
  and coalesce(pr.is_deleted, false)
  and (p.payout_wallet_address is not null or p.payout_wallet_network is not null
       or p.payout_bank_details is not null or p.payout_mpesa_phone is not null);

-- ── 8. Reclaim: never take what the client bought/earned (B1) ─
-- The client's balance is one pool, so "unused" cannot be told apart by source
-- from the balance alone. Assume oldest-first consumption: the unspent GB are
-- the NEWEST ones, so the unspent part of a transfer is whatever is left after
-- subtracting everything the client received LATER (purchases, referral bonuses,
-- other transfers). Also limited to 30 days after the transfer
-- (lib/reseller.ts RECLAIM_WINDOW_DAYS must match).
drop function if exists public.reclaim_reseller_allocation(uuid, uuid, numeric);

create or replace function public.reclaim_reseller_allocation(
  p_transfer_id uuid,
  p_reseller_id uuid,
  p_gb          numeric default null
)
returns table (out_reclaimed_gb numeric, out_remaining_gb numeric)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c_window constant interval := interval '30 days';
  t public.reseller_transfers%rowtype;
  v_remaining numeric;
  v_avail numeric;
  v_later numeric;
  v_amount numeric;
begin
  select * into t from public.reseller_transfers
  where id = p_transfer_id and reseller_id = p_reseller_id for update;
  if not found then
    raise exception 'Transfer not found';
  end if;
  if t.status <> 'active' then
    raise exception 'Nothing left to reclaim on this transfer';
  end if;
  if t.created_at < now() - c_window then
    raise exception 'Nothing left to reclaim — the 30-day reclaim window for this transfer has closed.';
  end if;

  perform 1 from public.bandwidth_accounts
  where user_id in (t.reseller_id, t.recipient_id) order by user_id for update;

  v_remaining := t.gb_amount - t.reclaimed_gb;
  select greatest(coalesce(available_gb, 0), 0) into v_avail
  from public.bandwidth_accounts where user_id = t.recipient_id;
  v_avail := coalesce(v_avail, 0);

  v_later :=
    coalesce((
      select sum(o.gb_amount * (1 - least(coalesce(o.refunded_usd, 0) / nullif(o.amount_usd, 0), 1)))
      from public.orders o
      where o.user_id = t.recipient_id and o.bandwidth_credited = true
        and coalesce(o.is_canary, false) = false and o.paid_at > t.created_at
    ), 0)
    + coalesce((
      select sum(x.gb_amount - x.reclaimed_gb)
      from public.reseller_transfers x
      where x.recipient_id = t.recipient_id and x.id <> t.id and x.created_at > t.created_at
    ), 0)
    + coalesce((
      select sum(rf.gb_bonus_amount)
      from public.referrals rf
      where (rf.referrer_id = t.recipient_id or rf.referred_user_id = t.recipient_id)
        and rf.gb_bonus_credited_at > t.created_at and rf.gb_bonus_reversed_at is null
    ), 0);

  v_amount := least(v_remaining, greatest(v_avail - v_later, 0));
  if p_gb is not null then
    v_amount := least(v_amount, p_gb);
  end if;
  v_amount := round(v_amount, 3);

  if v_amount <= 0 then
    raise exception 'Nothing to reclaim — the client has already used, assigned or topped up past this bandwidth.';
  end if;

  update public.bandwidth_accounts set total_gb = total_gb - v_amount where user_id = t.recipient_id;
  update public.bandwidth_accounts set allocated_gb = greatest(allocated_gb - v_amount, 0) where user_id = t.reseller_id;

  update public.reseller_transfers
  set reclaimed_gb = reclaimed_gb + v_amount,
      status = case when reclaimed_gb + v_amount >= gb_amount then 'reclaimed' else status end
  where id = t.id;

  return query select v_amount, v_remaining - v_amount;
end;
$$;

-- ── 9. Reseller roster / summary: only the GB THIS reseller sent (B5d) ─
create or replace function public.reseller_client_roster(
  p_reseller_id uuid,
  p_search      text default null,
  p_limit       integer default 25,
  p_offset      integer default 0
)
returns table (
  client_id           uuid,
  email               text,
  full_name           text,
  is_deleted          boolean,
  is_suspended        boolean,
  transfer_count      bigint,
  total_received_gb   numeric,
  total_reclaimed_gb  numeric,
  last_transfer_at    timestamptz,
  last_note           text,
  client_total_gb     numeric,
  client_used_gb      numeric,
  client_available_gb numeric,
  total_count         bigint
) language sql stable security definer set search_path = public, pg_temp as $$
  with agg as (
    select rt.recipient_id,
           count(*) as cnt,
           sum(rt.gb_amount) as recv,
           sum(rt.reclaimed_gb) as recl,
           max(rt.created_at) as last_at,
           (array_agg(rt.note order by rt.created_at desc) filter (where rt.note is not null))[1] as last_note
    from public.reseller_transfers rt
    where rt.reseller_id = p_reseller_id
    group by rt.recipient_id
  )
  select a.recipient_id, p.email, p.full_name,
         coalesce(p.is_deleted, false), coalesce(p.is_suspended, false),
         a.cnt, a.recv, a.recl, a.last_at, a.last_note,
         -- Scoped to what THIS reseller sent (net of reclaims): the client's
         -- other purchases / other resellers' transfers are not this
         -- reseller's business.
         (a.recv - a.recl),
         least(coalesce(b.used_gb, 0), a.recv - a.recl),
         least(greatest(coalesce(b.available_gb, 0), 0),
               greatest((a.recv - a.recl) - least(coalesce(b.used_gb, 0), a.recv - a.recl), 0)),
         count(*) over ()
  from agg a
  join public.profiles p on p.id = a.recipient_id
  left join public.bandwidth_accounts b on b.user_id = a.recipient_id
  where p_search is null or p_search = ''
     or p.email ilike '%' || replace(replace(p_search, '%', '\%'), '_', '\_') || '%'
     or p.full_name ilike '%' || replace(replace(p_search, '%', '\%'), '_', '\_') || '%'
  order by a.last_at desc
  limit least(greatest(p_limit, 1), 100) offset greatest(p_offset, 0);
$$;

create or replace function public.reseller_summary(p_reseller_id uuid)
returns table (
  total_allocated_gb numeric,
  total_reclaimed_gb numeric,
  transfer_count     bigint,
  client_count       bigint,
  clients_used_gb    numeric -- consumed by clients, capped per client at what this reseller sent them
) language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(rt.gb_amount), 0),
         coalesce(sum(rt.reclaimed_gb), 0),
         count(*),
         count(distinct rt.recipient_id),
         coalesce((
           select sum(least(coalesce(b.used_gb, 0), per.net))
           from (
             select recipient_id, sum(gb_amount - reclaimed_gb) as net
             from public.reseller_transfers where reseller_id = p_reseller_id
             group by recipient_id
           ) per
           left join public.bandwidth_accounts b on b.user_id = per.recipient_id
         ), 0)
  from public.reseller_transfers rt where rt.reseller_id = p_reseller_id;
$$;

-- ── 10. Affiliate dashboard aggregates: reversed bonuses don't count ─
drop function if exists public.my_affiliate_summary(uuid, date, date);

create or replace function public.my_affiliate_summary(p_user_id uuid, p_cycle_start date, p_cycle_end date)
returns table (
  accruing_usd    numeric,
  in_payout_usd   numeric,
  paid_usd        numeric,
  this_cycle_usd  numeric,
  referral_count  bigint,
  converted_count bigint,
  flagged_count   bigint,
  clicks_total    bigint,
  bonus_gb_total  numeric
) language sql stable security definer set search_path = public, pg_temp as $$
  select
    coalesce(sum(case when c.status = 'pending' and c.payout_id is null then c.commission_amount_usd end), 0),
    coalesce(sum(case when c.status = 'pending' and c.payout_id is not null then c.commission_amount_usd end), 0),
    coalesce(sum(case when c.status = 'paid' then c.commission_amount_usd end), 0),
    coalesce(sum(case when c.status <> 'void'
                        and (c.created_at at time zone 'UTC')::date between p_cycle_start and p_cycle_end
                      then c.commission_amount_usd end), 0),
    (select count(*) from public.referrals where referrer_id = p_user_id),
    (select count(*) from public.referrals r where r.referrer_id = p_user_id
        and (r.gb_bonus_credited_at is not null
             or exists (select 1 from public.affiliate_commissions x where x.referral_id = r.id))),
    (select count(*) from public.referrals where referrer_id = p_user_id and flagged),
    (select coalesce(sum(clicks), 0) from public.referral_clicks where referrer_id = p_user_id),
    (select coalesce(sum(gb_bonus_amount), 0) from public.referrals
       where referrer_id = p_user_id and gb_bonus_credited_at is not null and gb_bonus_reversed_at is null)
  from public.affiliate_commissions c
  where c.referrer_id = p_user_id;
$$;

drop function if exists public.my_referral_funnel(uuid, integer, integer);

create or replace function public.my_referral_funnel(p_user_id uuid, p_limit integer default 25, p_offset integer default 0)
returns table (
  referred_label  text,
  joined_at       timestamptz,
  sub_id          text,
  flagged         boolean,
  bonus_credited  boolean,
  bonus_reversed  boolean,
  first_purchase_at timestamptz,
  orders_count    bigint,
  earned_usd      numeric,
  total_count     bigint
) language sql stable security definer set search_path = public, pg_temp as $$
  select
    case when coalesce(p.is_deleted, false) then 'deleted account'
         else left(split_part(p.email, '@', 1), 1) || '***@' || left(split_part(p.email, '@', 2), 1) || '***'
              || coalesce(substring(split_part(p.email, '@', 2) from '\.[^.]+$'), '') end,
    r.created_at,
    r.sub_id,
    r.flagged,
    r.gb_bonus_credited_at is not null and r.gb_bonus_reversed_at is null,
    r.gb_bonus_reversed_at is not null,
    (select min(o.paid_at) from public.orders o where o.user_id = r.referred_user_id and o.bandwidth_credited and not coalesce(o.is_canary, false)),
    (select count(*) from public.orders o where o.user_id = r.referred_user_id and o.bandwidth_credited and not coalesce(o.is_canary, false)),
    (select coalesce(sum(c.commission_amount_usd), 0) from public.affiliate_commissions c where c.referral_id = r.id and c.status <> 'void'),
    count(*) over ()
  from public.referrals r
  join public.profiles p on p.id = r.referred_user_id
  where r.referrer_id = p_user_id
  order by r.created_at desc
  limit least(greatest(p_limit, 1), 100) offset greatest(p_offset, 0);
$$;

-- ── 11. Grants ───────────────────────────────────────────────
-- Everything here is service-role only (the convention since 0042).
do $$
declare
  f text;
begin
  foreach f in array array[
    'credit_referral_bonus(uuid, numeric, numeric, numeric, uuid)',
    'reverse_referral_bonus_on_refund()',
    'record_affiliate_commission(uuid, uuid, numeric, timestamptz)',
    'clear_referral_flag(uuid, numeric, numeric)',
    'reduce_commission_on_refund()',
    'scrub_affiliate_data(uuid)',
    'reclaim_reseller_allocation(uuid, uuid, numeric)',
    'reseller_client_roster(uuid, text, integer, integer)',
    'reseller_summary(uuid)',
    'my_affiliate_summary(uuid, date, date)',
    'my_referral_funnel(uuid, integer, integer)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    if f not like '%trigger%' and f not like 'reverse_referral_bonus_on_refund%' and f not like 'reduce_commission_on_refund%' then
      execute format('grant execute on function public.%s to service_role', f);
    end if;
  end loop;
end $$;

insert into public.schema_migrations (filename) values
  ('0051_section7_reseller_affiliates_closeout.sql')
on conflict do nothing;

-- ============================================================
-- 0052 — Admin & Verified Operators close-out
-- ============================================================
-- 1. Remove every DB-level admin read/write path. The TOTP step-up is a
--    cookie that PostgREST never sees, so an admin-role JWT from a
--    password-only sign-in could read affiliate payout destinations, the audit
--    log, support reports and the ban list, and write platform_settings,
--    straight over REST without ever passing MFA. Every admin screen already
--    reads and writes through MFA-gated server code using the service role, so
--    these policies had no legitimate user left. (Service role bypasses RLS.)
-- 2. profiles.api_access_rejected_at — API-access requests get the same 7-day
--    re-apply cooldown (reseller / affiliate got theirs in 0051), measured from
--    the REJECTION. Pinned by the profile-protection trigger.
-- 3. proxy_credentials.suspended_reason — account suspension no longer revives
--    credentials an admin disabled one by one, and deleted accounts' tombstoned
--    credentials stop polluting the admin list.
-- 4. admin_order_stats attributes revenue to when the order was PAID, the same
--    moment its affiliate commission is created, so a cycle's sales and
--    commissions describe the same orders.
-- 5. scrub_affiliate_data (as of 0051) also voids still-pending payouts of a
--    deleted account (their payout destination has just been erased, so they
--    can never be paid) and reports what it voided.
-- 6. Manual bandwidth adjustments (credit / debit) with a durable record.
-- 7. De-dupe table for "your payout is rolling forward" notices.
-- 8. Referral fraud confirmation; support report resolution metadata.

-- ── 1. Drop DB-level admin access ────────────────────────────
drop policy if exists "Admins can update any profile" on public.profiles;
drop policy if exists "Admin settings"               on public.platform_settings;
drop policy if exists "Admin can read banned emails" on public.banned_emails;
drop policy if exists "Admins can view all referrals"   on public.referrals;
drop policy if exists "Admins can view all commissions" on public.affiliate_commissions;
drop policy if exists "Admins can view all payouts"     on public.affiliate_payouts;
drop policy if exists "Admins can read audit log"       on public.admin_audit_log;
drop policy if exists "Admins can view all reports"     on public.support_reports;
drop policy if exists "Admins can update reports"       on public.support_reports;

-- ── 2. API-access rejection timestamp ───────────────────────
alter table public.profiles add column if not exists api_access_rejected_at timestamptz;

-- Full body = 0051's definition + the new column (a user must not be able to
-- clear their own cooldown).
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
  new.email                              := old.email; -- see migration 0011
  new.affiliate_status                   := old.affiliate_status; -- see migration 0031
  new.affiliate_commission_rate          := old.affiliate_commission_rate;
  new.affiliate_commission_rate_lifetime := old.affiliate_commission_rate_lifetime;
  new.payout_method                      := old.payout_method; -- see migration 0034, extended by 0035
  new.payout_wallet_address              := old.payout_wallet_address;
  new.payout_wallet_network              := old.payout_wallet_network;
  new.payout_bank_details                := old.payout_bank_details;
  new.payout_mpesa_phone                 := old.payout_mpesa_phone;
  new.payout_method_updated_at           := old.payout_method_updated_at;
  new.is_verified_operator               := old.is_verified_operator; -- see migration 0037
  new.verified_operator_since            := old.verified_operator_since;
  new.verified_operator_prev_rate        := old.verified_operator_prev_rate; -- see migration 0043
  new.verified_operator_prev_rate_lifetime := old.verified_operator_prev_rate_lifetime;
  new.mfa_enabled                        := old.mfa_enabled; -- see migration 0039_auth_mfa_hardening
  new.referral_code                      := old.referral_code; -- migration 0044
  new.reseller_rejected_at               := old.reseller_rejected_at; -- migration 0051
  new.affiliate_rejected_at              := old.affiliate_rejected_at;
  new.api_access_rejected_at             := old.api_access_rejected_at; -- migration 0052

  return new;
end;
$$;

-- ── 3. Why a credential is suspended ─────────────────────────
alter table public.proxy_credentials add column if not exists suspended_reason text;
alter table public.proxy_credentials drop constraint if exists proxy_credentials_suspended_reason_check;
alter table public.proxy_credentials add constraint proxy_credentials_suspended_reason_check
  check (suspended_reason is null or suspended_reason in ('account', 'admin', 'deleted'));

-- Tombstoned credentials of accounts deleted before this migration.
update public.proxy_credentials c
set suspended_reason = 'deleted'
from public.profiles p
where p.id = c.user_id
  and p.is_deleted
  and c.status = 'suspended'
  and c.suspended_reason is distinct from 'deleted';

-- ── 4. Revenue by payment time ───────────────────────────────
create or replace function public.admin_order_stats(
  p_start timestamptz default null,
  p_end   timestamptz default null
)
returns table (revenue_usd numeric, gb_sold numeric, order_count bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  select
    coalesce(sum(o.amount_usd - coalesce(o.refunded_usd, 0)), 0),
    coalesce(sum(o.gb_amount * (1 - least(coalesce(coalesce(o.refunded_usd, 0) / nullif(o.amount_usd, 0), 0), 1))), 0),
    count(*)
  from public.orders o
  where o.payment_status = 'paid'
    and o.is_canary = false
    and (p_start is null or coalesce(o.paid_at, o.created_at) >= p_start)
    and (p_end   is null or coalesce(o.paid_at, o.created_at) <  p_end);
$$;

revoke all on function public.admin_order_stats(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.admin_order_stats(timestamptz, timestamptz) to service_role;

-- ── 5. Account deletion voids still-pending payouts ──────────
drop function if exists public.scrub_affiliate_data(uuid);

create or replace function public.scrub_affiliate_data(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r           public.affiliate_payouts%rowtype;
  v_payouts   jsonb   := '[]'::jsonb;
  v_forfeited numeric := 0;
begin
  update public.profiles
  set payout_method = null,
      payout_wallet_address = null,
      payout_wallet_network = null,
      payout_bank_details = null,
      payout_mpesa_phone = null,
      payout_method_updated_at = null,
      affiliate_application = null,
      reseller_application = null,
      api_access_application = null,
      company_name = null,
      affiliate_status = case when affiliate_status is null then null else 'suspended' end
  where id = p_user_id;

  -- A payout that is still 'pending' can never be paid now: the destination
  -- it was batched for has just been erased. Release its commissions and
  -- remove the row (the unique (referrer, cycle) key makes a 'void' row
  -- impossible — see void_affiliate_payout). Paid payouts are financial
  -- records and are kept.
  for r in
    select * from public.affiliate_payouts
    where referrer_id = p_user_id and status = 'pending'
    for update
  loop
    v_payouts := v_payouts || jsonb_build_array(jsonb_build_object(
      'payout_id', r.id, 'cycle_start', r.cycle_start, 'cycle_end', r.cycle_end,
      'amount_usd', r.amount_usd, 'payout_method', r.payout_method
    ));
    update public.affiliate_commissions set payout_id = null where payout_id = r.id and status = 'pending';
    delete from public.affiliate_payouts where id = r.id;
  end loop;

  -- Earnings that were never batched are forfeited with the account.
  with voided as (
    update public.affiliate_commissions
    set status = 'void'
    where referrer_id = p_user_id and payout_id is null and status = 'pending'
    returning commission_amount_usd
  )
  select coalesce(sum(commission_amount_usd), 0) into v_forfeited from voided;

  -- Kept (paid) payout rows lose the destination snapshot: bank / wallet /
  -- phone details are personal data with no accounting value (0051).
  update public.affiliate_payouts
  set payout_wallet_address = null,
      payout_wallet_network = null,
      payout_bank_details = null,
      payout_mpesa_phone = null
  where referrer_id = p_user_id
    and (payout_wallet_address is not null or payout_wallet_network is not null
         or payout_bank_details is not null or payout_mpesa_phone is not null);

  return jsonb_build_object('voided_payouts', v_payouts, 'forfeited_usd', v_forfeited);
end;
$$;

revoke all on function public.scrub_affiliate_data(uuid) from public, anon, authenticated;
grant execute on function public.scrub_affiliate_data(uuid) to service_role;

-- Pending payouts of accounts that were deleted before this migration (0051
-- already erased their destination snapshot, so they are unpayable).
do $$
declare
  r record;
  v jsonb;
begin
  for r in
    select distinct p.referrer_id
    from public.affiliate_payouts p
    join public.profiles pr on pr.id = p.referrer_id
    where p.status = 'pending' and pr.is_deleted
  loop
    v := public.scrub_affiliate_data(r.referrer_id);
    insert into public.admin_audit_log (admin_id, action, target_user_id, details)
    values (null, 'payout.void_deleted_account', r.referrer_id, v || jsonb_build_object('source', 'migration_0052'));
  end loop;
end $$;

-- ── 6. Manual bandwidth adjustments ──────────────────────────
create table if not exists public.bandwidth_adjustments (
  id         uuid default uuid_generate_v4() primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  admin_id   uuid references public.profiles(id) on delete set null,
  gb_delta   numeric not null check (gb_delta <> 0),
  reason     text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_bandwidth_adjustments_user on public.bandwidth_adjustments (user_id, created_at desc);
alter table public.bandwidth_adjustments enable row level security; -- service role only
revoke all on table public.bandwidth_adjustments from anon, authenticated;

-- Credit or debit a user's purchased bandwidth and record why, atomically. A
-- debit can never take GB that is already committed to a credential
-- (available = total - allocated must cover it).
create or replace function public.admin_adjust_bandwidth(
  p_user_id  uuid,
  p_admin_id uuid,
  p_gb       numeric,
  p_reason   text
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_total numeric;
  v_alloc numeric;
begin
  if p_gb is null or p_gb = 0 then
    return jsonb_build_object('ok', false, 'reason', 'zero_amount');
  end if;
  if p_reason is null or length(btrim(p_reason)) < 3 then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;

  if p_gb > 0 then
    insert into public.bandwidth_accounts (user_id, total_gb, used_gb, allocated_gb)
    values (p_user_id, p_gb, 0, 0)
    on conflict (user_id) do update
      set total_gb = coalesce(public.bandwidth_accounts.total_gb, 0) + excluded.total_gb
    returning total_gb, allocated_gb into v_total, v_alloc;
  else
    select coalesce(total_gb, 0), coalesce(allocated_gb, 0) into v_total, v_alloc
    from public.bandwidth_accounts where user_id = p_user_id for update;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'no_account');
    end if;
    if (v_total - v_alloc) < -p_gb then
      return jsonb_build_object('ok', false, 'reason', 'insufficient_available', 'available_gb', v_total - v_alloc);
    end if;
    update public.bandwidth_accounts
    set total_gb = coalesce(total_gb, 0) + p_gb
    where user_id = p_user_id
    returning total_gb, allocated_gb into v_total, v_alloc;
  end if;

  insert into public.bandwidth_adjustments (user_id, admin_id, gb_delta, reason)
  values (p_user_id, p_admin_id, p_gb, btrim(p_reason));

  return jsonb_build_object('ok', true, 'total_gb', v_total, 'available_gb', v_total - v_alloc);
end;
$$;

revoke all on function public.admin_adjust_bandwidth(uuid, uuid, numeric, text) from public, anon, authenticated;
grant execute on function public.admin_adjust_bandwidth(uuid, uuid, numeric, text) to service_role;

-- ── 7. Payout roll-forward notice de-dupe ────────────────────
-- Re-running a payout cycle used to re-send the "your payout is rolling to the
-- next cycle" email to everyone still waiting. One notice per affiliate, cycle
-- and reason.
create table if not exists public.affiliate_rollover_notices (
  referrer_id uuid not null references public.profiles(id) on delete cascade,
  cycle_end   date not null,
  kind        text not null,
  sent_at     timestamptz not null default now(),
  primary key (referrer_id, cycle_end, kind)
);
alter table public.affiliate_rollover_notices enable row level security; -- service role only
revoke all on table public.affiliate_rollover_notices from anon, authenticated;

-- ── 8. Referral fraud confirmation, support report resolution ─
alter table public.referrals add column if not exists flag_confirmed_at timestamptz;

-- Confirmed fraud stays flagged forever (so it never earns) but leaves the
-- review queue.
create or replace function public.confirm_referral_fraud(p_referral_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  update public.referrals set flag_confirmed_at = now()
  where id = p_referral_id and flagged = true and flag_confirmed_at is null
  returning id into v_id;
  return v_id is not null;
end;
$$;

revoke all on function public.confirm_referral_fraud(uuid) from public, anon, authenticated;
grant execute on function public.confirm_referral_fraud(uuid) to service_role;

alter table public.support_reports add column if not exists resolved_by uuid references public.profiles(id) on delete set null;
alter table public.support_reports add column if not exists admin_note  text;

insert into public.schema_migrations (filename) values
  ('0052_admin_closeout.sql')
on conflict do nothing;

-- ============================================================
-- 0053_auth_mfa_pass3.sql
-- ============================================================
-- ─────────────────────────────────────────────────────────────────────
-- 0053 · Auth & MFA — independent pass 3
--
--  1. auth_account_state(): lets signup tell "already has an account" from
--     "closed account" so the address owner gets an explanatory email
--     instead of silence (still never revealed to the person typing it).
--  2. login_sessions: the browser's real IP / user-agent per login session.
--     auth.sessions only records the Worker's, because sign-in happens
--     server-side, so the "Where you're signed in" card showed the wrong
--     device. Keyed by auth.sessions.id (the JWT session_id claim).
--  3. wipe_mfa / confirm_totp_enrollment_atomic cancel any open 2FA
--     recovery request: once 2FA is removed or re-established, an older
--     recovery link must not stay usable.
--  4. mfa_complete_recovery refuses when there is no confirmed factor.
--  5. cleanup_old_security_events() also prunes orphaned login_sessions.
-- ─────────────────────────────────────────────────────────────────────

-- ── 1. account state for signup notices ──────────────────────────────
create or replace function public.auth_account_state(check_email text)
returns text
language plpgsql stable security definer set search_path = public, auth, pg_temp
as $$
declare
  u record;
  p record;
begin
  select id, email_confirmed_at into u
    from auth.users where lower(email) = lower(check_email) limit 1;
  if not found then return 'none'; end if;
  if u.email_confirmed_at is null then return 'unconfirmed'; end if;
  select is_suspended, is_deleted, deleted_at into p from public.profiles where id = u.id;
  if found and (coalesce(p.is_deleted, false) or p.deleted_at is not null) then return 'deleted'; end if;
  if found and coalesce(p.is_suspended, false) then return 'suspended'; end if;
  return 'active';
end;
$$;
revoke all on function public.auth_account_state(text) from public, anon, authenticated;
grant execute on function public.auth_account_state(text) to service_role;

-- ── 2. per-login device record ───────────────────────────────────────
create table if not exists public.login_sessions (
  session_id uuid primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  ip         text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists login_sessions_user_idx on public.login_sessions(user_id);
alter table public.login_sessions enable row level security;
-- No policies: service role only.

-- ── 3. recovery requests die with the factor they were for ───────────
create or replace function public.wipe_mfa(p_user_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  delete from public.mfa_totp_factors where user_id = p_user_id;
  delete from public.mfa_backup_codes where user_id = p_user_id;
  delete from public.mfa_verified_sessions where user_id = p_user_id;
  -- Any still-open recovery request is moot now (completed ones keep their
  -- completed_at so the audit trail is intact).
  update public.mfa_recovery_requests
     set cancelled_at = now()
   where user_id = p_user_id and completed_at is null and cancelled_at is null;
  update public.profiles set mfa_enabled = false where id = p_user_id;
end;
$$;
revoke all on function public.wipe_mfa(uuid) from public, anon, authenticated;
grant execute on function public.wipe_mfa(uuid) to service_role;

create or replace function public.confirm_totp_enrollment_atomic(
  p_user_id uuid, p_used_counter integer, p_hashes text[]
)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_confirmed boolean;
begin
  select confirmed into v_confirmed from public.mfa_totp_factors where user_id = p_user_id for update;
  if not found then
    raise exception 'No pending MFA enrollment found for this account.' using errcode = 'P0002';
  end if;
  if v_confirmed then
    raise exception 'MFA is already enabled for this account.' using errcode = 'P0001';
  end if;

  update public.mfa_totp_factors
    set confirmed = true, confirmed_at = now(), failed_attempts = 0, locked_until = null,
        last_used_at = now(), last_used_counter = p_used_counter
    where user_id = p_user_id;
  update public.profiles set mfa_enabled = true where id = p_user_id;

  delete from public.mfa_backup_codes where user_id = p_user_id and used_at is null;
  insert into public.mfa_backup_codes (user_id, code_hash)
    select p_user_id, h from unnest(p_hashes) as h;

  -- A recovery link issued for the previous authenticator must not outlive
  -- the new one.
  update public.mfa_recovery_requests
     set cancelled_at = now()
   where user_id = p_user_id and completed_at is null and cancelled_at is null;
end;
$$;
revoke all on function public.confirm_totp_enrollment_atomic(uuid, integer, text[]) from public, anon, authenticated;
grant execute on function public.confirm_totp_enrollment_atomic(uuid, integer, text[]) to service_role;

-- ── 4. completion needs a factor to remove ───────────────────────────
create or replace function public.mfa_complete_recovery(p_request_id uuid, p_user_id uuid, p_window interval)
returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  if not exists (select 1 from public.mfa_totp_factors where user_id = p_user_id and confirmed) then
    return false;
  end if;
  update public.mfa_recovery_requests
     set completed_at = now()
   where id = p_request_id
     and user_id = p_user_id
     and completed_at is null
     and cancelled_at is null
     and confirmed_at is not null
     and ready_at <= now()
     and ready_at + p_window > now()
  returning id into v_id;
  if v_id is null then return false; end if;
  perform public.wipe_mfa(p_user_id);
  return true;
end;
$$;
revoke all on function public.mfa_complete_recovery(uuid, uuid, interval) from public, anon, authenticated;
grant execute on function public.mfa_complete_recovery(uuid, uuid, interval) to service_role;

-- ── 5. cleanup ───────────────────────────────────────────────────────
create or replace function public.cleanup_old_security_events()
returns integer language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare v_deleted integer;
begin
  delete from public.security_events where created_at < now() - interval '365 days';
  get diagnostics v_deleted = row_count;
  delete from public.auth_throttle where window_start < now() - interval '1 day';
  delete from public.mfa_recovery_requests where created_at < now() - interval '90 days';
  delete from public.login_sessions ls
   where ls.created_at < now() - interval '1 day'
     and not exists (select 1 from auth.sessions s where s.id = ls.session_id);
  return v_deleted;
end;
$$;
revoke all on function public.cleanup_old_security_events() from public, anon, authenticated;
grant execute on function public.cleanup_old_security_events() to service_role;

insert into public.schema_migrations (filename) values
  ('0053_auth_mfa_pass3.sql')
on conflict do nothing;

-- ============================================================
-- 0054_api_integrations_closeout.sql
-- ============================================================
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

-- ============================================================
-- 0055 — Edge & request pipeline close-out (section 1, audit pass 2)
-- ============================================================
-- Idempotent: safe to re-run. Apply AFTER 0054_api_integrations_closeout.sql.
--
--  * G2  cron_task_runs + record_cron_task_run() + claim_stale_cron_tasks():
--        every scheduled task now leaves a heartbeat (last run / last success /
--        last error / consecutive failures). A task that fails three runs in a
--        row, or stops running altogether, alerts the admin once per incident
--        instead of only writing to a log that rotates away. Before this only
--        the 'usage' task had a staleness watchdog.
--  * G4  csp_violations + record_csp_violation() + prune_csp_violations():
--        Content-Security-Policy-Report-Only reports are aggregated (one row
--        per directive / blocked URL / page, with a hit counter) so the policy
--        can actually be reviewed and promoted to enforcing. The table is
--        capped at 500 distinct rows so the public report endpoint cannot be
--        used to grow it.
--
-- Both tables have RLS on and NO policies: only the service role touches them.

-- ── G2: cron heartbeat ──────────────────────────────────────────────
create table if not exists public.cron_task_runs (
  task                 text primary key,
  last_run_at          timestamptz not null default now(),
  last_ok_at           timestamptz,
  last_error           text,
  last_error_at        timestamptz,
  consecutive_failures integer not null default 0,
  alerted_at           timestamptz,
  stale_alerted_at     timestamptz
);

alter table public.cron_task_runs enable row level security;
revoke all on table public.cron_task_runs from anon, authenticated;

-- Records one run. Returns TRUE when the admin should be alerted about a
-- failing task right now: three consecutive failures, at most once per 24h per
-- incident (the claim is a single UPDATE, so two concurrent failures cannot
-- both alert). A success resets the streak and re-arms both alerts.
create or replace function public.record_cron_task_run(p_task text, p_ok boolean, p_error text default null)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.cron_task_runs (task) values (p_task) on conflict (task) do nothing;

  if p_ok then
    update public.cron_task_runs
       set last_run_at = now(), last_ok_at = now(), consecutive_failures = 0,
           alerted_at = null, stale_alerted_at = null
     where task = p_task;
    return false;
  end if;

  update public.cron_task_runs
     set last_run_at = now(), last_error = left(coalesce(p_error, 'unknown error'), 500),
         last_error_at = now(), consecutive_failures = consecutive_failures + 1,
         stale_alerted_at = null
   where task = p_task;

  update public.cron_task_runs
     set alerted_at = now()
   where task = p_task
     and consecutive_failures >= 3
     and (alerted_at is null or alerted_at < now() - interval '24 hours');
  return found;
end;
$$;

-- Tasks whose last run is older than their allowed age (seconds, keyed by task
-- name) and that have not been reported yet. Claims them atomically so the
-- hourly check emails each stale task once per incident.
create or replace function public.claim_stale_cron_tasks(p_max_age_seconds jsonb)
returns table (task text, last_run_at timestamptz)
language sql security definer set search_path = public, pg_temp as $$
  update public.cron_task_runs r
     set stale_alerted_at = now()
   where r.stale_alerted_at is null
     and (p_max_age_seconds ->> r.task) is not null
     and r.last_run_at < now() - make_interval(secs => (p_max_age_seconds ->> r.task)::double precision)
  returning r.task, r.last_run_at;
$$;

-- ── G4: CSP report aggregation ──────────────────────────────────────
create table if not exists public.csp_violations (
  fingerprint   text primary key,
  directive     text not null,
  blocked       text not null,
  document      text not null,
  hits          integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create index if not exists csp_violations_last_seen_idx on public.csp_violations (last_seen_at desc);

alter table public.csp_violations enable row level security;
revoke all on table public.csp_violations from anon, authenticated;

create or replace function public.record_csp_violation(p_directive text, p_blocked text, p_document text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_directive text := left(coalesce(p_directive, ''), 200);
  v_blocked   text := left(coalesce(p_blocked, ''), 200);
  v_document  text := left(coalesce(p_document, ''), 200);
  v_fp        text := md5(v_directive || '|' || v_blocked || '|' || v_document);
begin
  -- Known row: just count it.
  update public.csp_violations set hits = hits + 1, last_seen_at = now() where fingerprint = v_fp;
  if found then return; end if;
  -- New row: only while the table is small, so a flood of made-up reports
  -- cannot grow it without bound.
  if (select count(*) from public.csp_violations) >= 500 then return; end if;
  insert into public.csp_violations (fingerprint, directive, blocked, document)
  values (v_fp, v_directive, v_blocked, v_document)
  on conflict (fingerprint) do update set hits = public.csp_violations.hits + 1, last_seen_at = now();
end;
$$;

create or replace function public.prune_csp_violations()
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_deleted integer;
begin
  delete from public.csp_violations where last_seen_at < now() - interval '30 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'record_cron_task_run(text, boolean, text)',
    'claim_stale_cron_tasks(jsonb)',
    'record_csp_violation(text, text, text)',
    'prune_csp_violations()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

insert into public.schema_migrations (filename) values
  ('0055_edge_pipeline_closeout.sql')
on conflict do nothing;

-- ============================================================
-- 0056_edge_pipeline_pass3.sql
-- ============================================================
create table if not exists public.cron_task_locks (
  task         text primary key,
  locked_until timestamptz not null,
  locked_at    timestamptz not null default now(),
  lock_token   text not null
);

alter table public.cron_task_locks enable row level security;
revoke all on table public.cron_task_locks from anon, authenticated;

-- Takes the lease when it is free or expired. Returns the token to release it
-- with, or NULL when another run still holds it. One statement, so two
-- concurrent callers cannot both win.
create or replace function public.claim_cron_task_lock(p_task text, p_lease_seconds integer, p_token text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_token text;
begin
  insert into public.cron_task_locks (task, locked_until, locked_at, lock_token)
  values (p_task, now() + make_interval(secs => greatest(p_lease_seconds, 1)), now(), p_token)
  on conflict (task) do update
     set locked_until = excluded.locked_until, locked_at = now(), lock_token = excluded.lock_token
   where public.cron_task_locks.locked_until <= now()
  returning lock_token into v_token;
  return v_token;
end;
$$;

-- Releases only the caller's own lease: a run that overran its lease must not
-- free a newer run's lock.
create or replace function public.release_cron_task_lock(p_task text, p_token text)
returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.cron_task_locks set locked_until = now() where task = p_task and lock_token = p_token;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'claim_cron_task_lock(text, integer, text)',
    'release_cron_task_lock(text, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

insert into public.schema_migrations (filename) values
  ('0056_edge_pipeline_pass3.sql')
on conflict do nothing;

-- ============================================================
-- 0057_payments_billing_pass2.sql
-- ============================================================
-- ============================================================
-- 0057 — Payments & billing close-out (audit section 3, round 2)
-- ============================================================
-- 1. orders.plan_slug: which plan (or 'custom') an order bought, so invoices
--    and reports can name it. (orders.plan_id points at the unused `plans`
--    table and was never written.)
-- 2. orders.refund_requested_at + claim_refund_request(): an atomic,
--    row-locked "a refund is already in flight" guard for the admin refund
--    route. The old guard read the audit log first and wrote it only after
--    the Paystack call, so two near-simultaneous clicks both passed. The lock
--    is cleared when Paystack reports the refund processed / failed
--    (apply_order_refund below, and the webhook's refund.failed handler) and
--    expires on its own after 24h so a lost event can never strand an order.
-- 3. orders.billing_details_revision / _updated_at + reissue_invoice_details():
--    a customer who forgot their VAT id / address can re-snapshot their CURRENT
--    billing details onto an invoice they were already issued. Capped at 3
--    revisions per invoice, never touches amounts, number or dates, and the
--    invoice page shows that it was revised.
-- 4. protect_order_columns() pins the new columns against customer writes.
-- 5. apply_order_refund() also clears refund_requested_at.

-- ── 1. columns ──────────────────────────────────────────────
alter table public.orders add column if not exists plan_slug text;
alter table public.orders add column if not exists refund_requested_at timestamptz;
alter table public.orders add column if not exists billing_details_revision integer not null default 0;
alter table public.orders add column if not exists billing_details_updated_at timestamptz;

-- ── 4. protect_order_columns ────────────────────────────────
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

  new.user_id                      := old.user_id;
  new.plan_id                      := old.plan_id;
  new.gb_amount                    := old.gb_amount;
  new.amount_usd                   := old.amount_usd;
  new.payment_method               := old.payment_method;
  new.paystack_reference           := old.paystack_reference;
  new.bandwidth_credited           := old.bandwidth_credited;
  new.paid_at                      := old.paid_at;
  new.created_at                   := old.created_at;
  new.invoice_number               := old.invoice_number;
  new.failure_reason               := old.failure_reason;
  new.failed_at                    := old.failed_at;
  new.is_canary                    := old.is_canary;
  new.refunded_usd                 := old.refunded_usd;
  new.refunded_at                  := old.refunded_at;
  new.reconcile_checked_at         := old.reconcile_checked_at;
  new.post_credit_done_at          := old.post_credit_done_at;
  new.billing_details              := old.billing_details;
  new.dispute_status               := old.dispute_status;
  new.dispute_opened_at            := old.dispute_opened_at;
  new.dispute_resolution           := old.dispute_resolution;
  new.pay_currency                 := old.pay_currency;
  new.pay_amount                   := old.pay_amount;
  new.fx_rate                      := old.fx_rate;
  new.plan_slug                    := old.plan_slug;
  new.refund_requested_at          := old.refund_requested_at;
  new.billing_details_revision     := old.billing_details_revision;
  new.billing_details_updated_at   := old.billing_details_updated_at;

  return new;
end;
$$;

-- ── 5. apply_order_refund (0047 body + clears the in-flight lock) ──
create or replace function public.apply_order_refund(
  p_order_id uuid,
  p_refund_reference text,
  p_refund_usd numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order     public.orders%rowtype;
  v_credited  boolean;
  v_refund    numeric;
  v_gb        numeric;
  v_avail     numeric;
  v_claw      numeric;
  v_inserted  text;
  v_total     numeric;
  v_note      text;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('applied', false, 'reason', 'order_not_found');
  end if;

  -- Serialised by the order lock above, so a redelivered refund event is a
  -- clean no-op that does not burn a credit-note number.
  if exists (select 1 from public.order_refunds where refund_reference = p_refund_reference) then
    return jsonb_build_object('applied', false, 'reason', 'duplicate');
  end if;

  v_credited := v_order.bandwidth_credited is true;
  -- An uncredited order can still have been paid (webhook delayed): refunds
  -- against it are recorded. Anything else uncredited is not a real payment.
  if not v_credited and v_order.payment_status not in ('pending', 'cancelled', 'failed') then
    return jsonb_build_object('applied', false, 'reason', 'order_never_credited');
  end if;

  v_refund := least(p_refund_usd, v_order.amount_usd - v_order.refunded_usd);
  if v_refund is null or v_refund <= 0 then
    return jsonb_build_object('applied', false, 'reason', 'nothing_to_refund');
  end if;

  if v_credited then
    v_gb := round(v_order.gb_amount * v_refund / v_order.amount_usd, 6);
    select available_gb into v_avail
    from public.bandwidth_accounts where user_id = v_order.user_id for update;
    v_claw := least(v_gb, greatest(coalesce(v_avail, 0), 0));
  else
    v_gb := 0;
    v_claw := 0;
  end if;

  v_note := 'CN-' || to_char(now() at time zone 'UTC', 'YYYY')
            || '-' || lpad(nextval('public.credit_note_seq')::text, 6, '0');

  insert into public.order_refunds (refund_reference, order_id, amount_usd, gb_clawed, gb_shortfall, credit_note_number)
  values (p_refund_reference, p_order_id, v_refund, v_claw, v_gb - v_claw, v_note)
  on conflict (refund_reference) do nothing
  returning refund_reference into v_inserted;

  if v_inserted is null then
    return jsonb_build_object('applied', false, 'reason', 'duplicate');
  end if;

  if v_claw > 0 then
    update public.bandwidth_accounts
    set total_gb = total_gb - v_claw
    where user_id = v_order.user_id;
  end if;

  v_total := v_order.refunded_usd + v_refund;
  update public.orders
  set refunded_usd         = v_total,
      refunded_at          = now(),
      refund_requested_at  = null,
      payment_status       = case when v_total >= amount_usd then 'refunded' else payment_status end
  where id = p_order_id;

  return jsonb_build_object(
    'applied', true,
    'credited', v_credited,
    'refund_usd', v_refund,
    'gb_clawed', v_claw,
    'gb_shortfall', v_gb - v_claw,
    'fully_refunded', v_total >= v_order.amount_usd,
    'credit_note', v_note
  );
end;
$$;

-- ── 2. claim_refund_request ─────────────────────────────────
-- true  = caller now owns the right to send ONE refund request for this order
-- false = one is already in flight (requested within the last 24h and Paystack
--         has not yet reported it processed or failed) or the order is gone.
create or replace function public.claim_refund_request(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_at timestamptz;
begin
  select refund_requested_at into v_at from public.orders where id = p_order_id for update;
  if not found then
    return false;
  end if;
  if v_at is not null and v_at > now() - interval '24 hours' then
    return false;
  end if;
  update public.orders set refund_requested_at = now() where id = p_order_id;
  return true;
end;
$$;

-- ── 3. reissue_invoice_details ──────────────────────────────
create or replace function public.reissue_invoice_details(p_order_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order  public.orders%rowtype;
  v_new    jsonb;
  c_max    constant integer := 3;
begin
  select * into v_order from public.orders where id = p_order_id and user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_order.is_canary or v_order.invoice_number is null or v_order.payment_status not in ('paid', 'refunded') then
    return jsonb_build_object('ok', false, 'reason', 'no_invoice');
  end if;

  select jsonb_strip_nulls(jsonb_build_object(
    'name',    coalesce(nullif(btrim(pr.company_name), ''), nullif(btrim(pr.full_name), '')),
    'contact', nullif(btrim(pr.full_name), ''),
    'email',   pr.email,
    'address', nullif(btrim(pr.billing_address), ''),
    'tax_id',  nullif(btrim(pr.tax_id), '')
  )) into v_new
  from public.profiles pr where pr.id = p_user_id;

  if v_new is null then
    return jsonb_build_object('ok', false, 'reason', 'no_profile');
  end if;
  if v_order.billing_details is not null and v_order.billing_details = v_new then
    return jsonb_build_object('ok', true, 'unchanged', true, 'revision', v_order.billing_details_revision);
  end if;
  if v_order.billing_details_revision >= c_max then
    return jsonb_build_object('ok', false, 'reason', 'limit_reached', 'limit', c_max);
  end if;

  update public.orders
  set billing_details            = v_new,
      billing_details_revision   = billing_details_revision + 1,
      billing_details_updated_at = now()
  where id = p_order_id;

  return jsonb_build_object('ok', true, 'unchanged', false, 'revision', v_order.billing_details_revision + 1, 'limit', c_max);
end;
$$;

-- Same posture as 0042/0047: service role only.
revoke all on function public.claim_refund_request(uuid) from public, anon, authenticated;
grant execute on function public.claim_refund_request(uuid) to service_role;
revoke all on function public.reissue_invoice_details(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reissue_invoice_details(uuid, uuid) to service_role;
revoke all on function public.apply_order_refund(uuid, text, numeric) from public, anon, authenticated;
grant execute on function public.apply_order_refund(uuid, text, numeric) to service_role;

insert into public.schema_migrations (filename) values
  ('0057_payments_billing_pass2.sql')
on conflict do nothing;

-- ============================================================
-- 0058 — Admin section closeout (pass 2)
-- ============================================================
-- 1. clear_referral_flag(): the back-fill paid commission on the GROSS order
--    amount, so clearing a flag after the referred user's order had been
--    refunded paid commission on money that was already returned (the bonus
--    path next to it already used amount - refunded). It now back-fills on
--    the NET amount and skips orders that were refunded in full. It also
--    clears flag_confirmed_at in the same statement as the flag, instead of
--    the route doing it as a second, unchecked write.
-- 2. Deleted accounts can no longer keep the Verified Operator flag (the
--    anonymising patch left it behind, so a deleted operator still counted).
--
-- Idempotent; safe to run against the live DB.

create or replace function public.clear_referral_flag(
  p_referral_id   uuid,
  p_gb            numeric default 1,
  p_min_order_usd numeric default 5
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r              public.referrals%rowtype;
  v_status       text;
  o              record;
  v_res          jsonb;
  v_net          numeric;
  v_count        integer := 0;
  v_total        numeric := 0;
  v_bonus        boolean := false;
begin
  update public.referrals
  set flagged = false, flag_reason = null, flag_confirmed_at = null
  where id = p_referral_id and flagged = true
  returning * into r;
  if not found then
    return null;
  end if;

  select affiliate_status into v_status from public.profiles where id = r.referrer_id;

  for o in
    select id, amount_usd, coalesce(refunded_usd, 0) as refunded_usd, coalesce(paid_at, created_at) as earned_at
    from public.orders
    where user_id = r.referred_user_id
      and bandwidth_credited = true
      and coalesce(is_canary, false) = false
    order by coalesce(paid_at, created_at), created_at
  loop
    v_net := o.amount_usd - o.refunded_usd;
    -- Nothing left of this order to earn on.
    continue when v_net <= 0;

    if v_status = 'approved' then
      v_res := public.record_affiliate_commission(r.id, o.id, v_net, o.earned_at);
      if v_res is not null then
        v_count := v_count + 1;
        v_total := v_total + (v_res->>'commission_usd')::numeric;
      end if;
    elsif v_status is distinct from 'suspended' and not v_bonus then
      if public.credit_referral_bonus(r.id, p_gb, v_net, p_min_order_usd, o.id) then
        v_bonus := true;
      end if;
    end if;
  end loop;

  return jsonb_build_object('commissions_backfilled', v_count, 'commission_usd', v_total, 'bonus_credited', v_bonus);
end;
$$;

revoke all on function public.clear_referral_flag(uuid, numeric, numeric) from public, anon, authenticated;
grant execute on function public.clear_referral_flag(uuid, numeric, numeric) to service_role;

-- 2. Clean up operators whose accounts were already deleted.
update public.profiles
set is_verified_operator = false,
    verified_operator_since = null,
    verified_operator_prev_rate = null,
    verified_operator_prev_rate_lifetime = null
where is_deleted = true
  and (is_verified_operator = true or verified_operator_since is not null);

insert into public.schema_migrations (filename) values
  ('0058_admin_section8_closeout.sql')
on conflict do nothing;

-- ============================================================
-- Migration 0059 — Proxy lifecycle close-out
-- ============================================================
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

-- ── 0060: Auth & MFA pass 4 ─────────────────────────────────────
-- ── 1. quarantine ────────────────────────────────────────────────────
create table if not exists public.auth_pending_password (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  hash       text not null,
  created_at timestamptz not null default now()
);
alter table public.auth_pending_password enable row level security;
-- No policies: service role / SECURITY DEFINER functions only.

create or replace function public.auth_hold_unconfirmed_password()
returns trigger
language plpgsql security definer set search_path = public, auth, extensions, pg_temp
as $$
begin
  if old.email_confirmed_at is null
     and new.email_confirmed_at is not null
     and coalesce(old.encrypted_password, '') <> '' then
    insert into public.auth_pending_password (user_id, hash, created_at)
    values (new.id, old.encrypted_password, now())
    on conflict (user_id) do update set hash = excluded.hash, created_at = excluded.created_at;
    new.encrypted_password := extensions.crypt(
      gen_random_uuid()::text || gen_random_uuid()::text, extensions.gen_salt('bf', 10));
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_hold_password on auth.users;
create trigger on_auth_user_hold_password
  before update of email_confirmed_at on auth.users
  for each row execute procedure public.auth_hold_unconfirmed_password();

-- Called by /auth/callback after a successful same-browser code exchange.
-- Only honoured shortly after confirmation, and only while the quarantined
-- password has not been superseded by a real password change.
create or replace function public.auth_restore_pending_password(p_user_id uuid)
returns boolean
language plpgsql security definer set search_path = public, auth, pg_temp
as $$
declare
  v_hash text;
begin
  select hash into v_hash
    from public.auth_pending_password
   where user_id = p_user_id and created_at > now() - interval '30 minutes'
   for update;
  if not found then
    delete from public.auth_pending_password where user_id = p_user_id;
    return false;
  end if;

  perform set_config('gp.restoring_pw', '1', true);
  update auth.users
     set encrypted_password = v_hash, updated_at = now()
   where id = p_user_id and email_confirmed_at is not null and deleted_at is null;
  delete from public.auth_pending_password where user_id = p_user_id;
  perform set_config('gp.restoring_pw', '', true);
  return true;
end;
$$;

revoke all on function public.auth_restore_pending_password(uuid) from public, anon, authenticated;
grant execute on function public.auth_restore_pending_password(uuid) to service_role;
revoke all on function public.auth_hold_unconfirmed_password() from public, anon, authenticated;

-- ── 2. password-change trigger ───────────────────────────────────────
create or replace function public.on_auth_password_changed()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.encrypted_password is distinct from old.encrypted_password
     and old.encrypted_password is not null
     and old.email_confirmed_at is not null
     and new.email_confirmed_at is not null
     and coalesce(current_setting('gp.restoring_pw', true), '') <> '1' then
    -- A real change supersedes any quarantined signup password.
    delete from public.auth_pending_password where user_id = new.id;
    delete from public.mfa_verified_sessions where user_id = new.id;
    insert into public.security_events (user_id, event, notify, meta)
    select new.id, 'password_changed', true, jsonb_build_object('source', 'db_trigger')
    where exists (select 1 from public.profiles where id = new.id);
  end if;
  return new;
end;
$$;

-- ── 3. profiles.mfa_enabled follows the factor table ─────────────────
create or replace function public.sync_profile_mfa_enabled()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := coalesce(new.user_id, old.user_id);
  v_on  boolean;
begin
  select exists (select 1 from public.mfa_totp_factors where user_id = v_uid and confirmed) into v_on;
  update public.profiles set mfa_enabled = v_on where id = v_uid and mfa_enabled is distinct from v_on;
  return null;
end;
$$;
revoke all on function public.sync_profile_mfa_enabled() from public, anon, authenticated;

drop trigger if exists mfa_factors_sync_profile on public.mfa_totp_factors;
create trigger mfa_factors_sync_profile
  after insert or update of confirmed or delete on public.mfa_totp_factors
  for each row execute procedure public.sync_profile_mfa_enabled();

-- One-time repair of any drift that already exists.
update public.profiles p
   set mfa_enabled = exists (select 1 from public.mfa_totp_factors f where f.user_id = p.id and f.confirmed)
 where p.mfa_enabled is distinct from
       exists (select 1 from public.mfa_totp_factors f where f.user_id = p.id and f.confirmed);

insert into public.schema_migrations (filename) values
  ('0060_auth_mfa_pass4.sql')
on conflict do nothing;

-- ============================================================
-- 0061 — Edge & request pipeline, audit pass 4
-- ============================================================
-- Idempotent: safe to re-run. Apply AFTER 0060_auth_mfa_pass4.sql.
--
--  * B2  record_csp_violation(): the table is capped at 500 rows, but once full
--        every NEW report was silently dropped. The report endpoint is public,
--        so a flood of made-up reports could fill the cap and keep genuine
--        violations out for as long as the flood kept the rows fresh. A full
--        table now EVICTS its least-hit, least-recently-seen row to make room,
--        so recurring (real) violations survive and new ones are always recorded.
--  * G3  claim_stale_cron_tasks(): a task with no cron_task_runs row at all
--        (its trigger never fired since it was added) was invisible to the
--        staleness check. Every task named in the age map now gets a row, dated
--        "first seen now", so it goes stale — and alerts once — if it never runs.

create or replace function public.record_csp_violation(p_directive text, p_blocked text, p_document text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_directive text := left(coalesce(p_directive, ''), 200);
  v_blocked   text := left(coalesce(p_blocked, ''), 200);
  v_document  text := left(coalesce(p_document, ''), 200);
  v_fp        text := md5(v_directive || '|' || v_blocked || '|' || v_document);
begin
  -- Known row: just count it.
  update public.csp_violations set hits = hits + 1, last_seen_at = now() where fingerprint = v_fp;
  if found then return; end if;
  -- New row. While the table is full, make room by dropping the row that has
  -- the fewest hits (oldest first) rather than refusing the new report.
  if (select count(*) from public.csp_violations) >= 500 then
    delete from public.csp_violations
     where fingerprint = (
       select fingerprint from public.csp_violations
        order by hits asc, last_seen_at asc
        limit 1
     );
  end if;
  insert into public.csp_violations (fingerprint, directive, blocked, document)
  values (v_fp, v_directive, v_blocked, v_document)
  on conflict (fingerprint) do update set hits = public.csp_violations.hits + 1, last_seen_at = now();
end;
$$;

create or replace function public.claim_stale_cron_tasks(p_max_age_seconds jsonb)
returns table (task text, last_run_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
begin
  -- A task that has never reported has no row to age. Give it one, dated now.
  insert into public.cron_task_runs (task, last_run_at)
  select k, now() from jsonb_object_keys(coalesce(p_max_age_seconds, '{}'::jsonb)) as k
  on conflict (task) do nothing;

  return query
  update public.cron_task_runs r
     set stale_alerted_at = now()
   where r.stale_alerted_at is null
     and (p_max_age_seconds ->> r.task) is not null
     and r.last_run_at < now() - make_interval(secs => (p_max_age_seconds ->> r.task)::double precision)
  returning r.task, r.last_run_at;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'record_csp_violation(text, text, text)',
    'claim_stale_cron_tasks(jsonb)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

insert into public.schema_migrations (filename) values
  ('0061_edge_pipeline_pass4.sql')
on conflict do nothing;

-- ============================================================
-- 0062_api_integrations_closeout.sql
-- ============================================================
-- 0062: API & integrations closeout
--
-- 1. 'bandwidth_debited' webhook event (support debits were invisible to
--    integrations). The list below is 0059's, plus that one event — a constraint
--    rewritten from a stale list would silently reject every endpoint subscribed
--    to the events it forgot.
-- 2. proxy_credentials.suspended_reason gains 'customer': a sub-user the owner
--    paused through POST /api/v1/sub-users/:id/pause. Account re-enable only
--    restores NULL/'account', so a paused sub-user stays paused through an
--    account suspension cycle, and only its owner can resume it.

alter table public.webhook_endpoints drop constraint if exists webhook_endpoints_valid_events;
alter table public.webhook_endpoints
  add constraint webhook_endpoints_valid_events
  check (event_types <@ array[
    'session_created', 'session_activated', 'session_deleted', 'session_topped_up',
    'session_released', 'session_low', 'session_exhausted',
    'session_suspended', 'session_resumed',
    'auto_topup_triggered', 'auto_topup_failed',
    'bandwidth_threshold_crossed', 'bandwidth_exhausted', 'bandwidth_credited', 'bandwidth_debited',
    'bandwidth_allocated', 'bandwidth_reclaimed', 'bandwidth_refunded',
    'api_key_created', 'api_key_revoked', 'api_key_expiring'
  ]::text[]);

alter table public.proxy_credentials drop constraint if exists proxy_credentials_suspended_reason_check;
alter table public.proxy_credentials
  add constraint proxy_credentials_suspended_reason_check
  check (suspended_reason is null or suspended_reason in ('account', 'admin', 'deleted', 'customer'));

insert into public.schema_migrations (filename) values
  ('0062_api_integrations_closeout.sql')
on conflict do nothing;

-- ============================================================
-- 0063_dashboard_ui_pass.sql
-- ============================================================
-- 0063: Dashboard UI pass
--
-- profiles.low_bandwidth_emails — opt-out for the "your session is 80% / 95%
-- used" e-mails (usageSync's low-bandwidth notice). Default ON, so nobody
-- loses the warning they have today; a customer who drives everything through
-- the API and webhooks can now turn the e-mails off. This covers ONLY that
-- advisory e-mail: the "ran out" notice, security e-mails and receipts are not
-- optional, and webhooks are unaffected (they're opted into per endpoint).

alter table public.profiles
  add column if not exists low_bandwidth_emails boolean not null default true;

insert into public.schema_migrations (filename) values
  ('0063_dashboard_ui_pass.sql')
on conflict do nothing;

-- 0064_proxy_lifecycle_pass2.sql
-- Proxy lifecycle, independent pass 2 (fix round):
--
--  1. Re-attemptable provisioning: the upstream username/password for a
--     pending credential are decided and PERSISTED before the supplier is
--     called, so a retry after an ambiguous failure (timeout / 5xx after the
--     sub-user was actually created) re-uses the same identity and can adopt the
--     existing sub-user instead of creating a second, orphaned one.
--  2. Live-cap drift escalation: limit_sync_failed_since / limit_sync_alerted_at
--     let the cron tell the customer and the admin when a committed allocation
--     could not be applied to the live proxy for a prolonged time.
--  3. usage_daily + record_usage_deltas(): account-level daily usage kept
--     locally, so usage history covers deleted sessions and accounts with many
--     sessions, and no longer needs a supplier call per session per page load.
--  4. recalculate_bandwidth_accounts(): suspended sessions' consumed GB stay in
--     used_gb (they used to drop out of the sum while suspended).
--  5. Webhook events 'session_updated', 'session_password_rotated',
--     'whitelist_changed' (keep in sync with lib/webhookEvents.ts).
--
-- Keep supabase/schema.sql in sync (scripts/check-schema-sync.mjs).

-- ── 1 + 2. Columns ────────────────────────────────────────────
-- NOT granted to `authenticated` (0059 grants an explicit column list; new
-- columns are fail-closed), so customers cannot read the provisioning identity.
alter table public.proxy_credentials
  add column if not exists provision_username       text,
  add column if not exists provision_password       text,
  add column if not exists limit_sync_failed_since  timestamptz,
  add column if not exists limit_sync_alerted_at    timestamptz;

create unique index if not exists proxy_credentials_provision_username_key
  on public.proxy_credentials (provision_username)
  where provision_username is not null;

-- ── 3. Local daily usage ──────────────────────────────────────
create table if not exists public.usage_daily (
  user_id uuid not null references public.profiles(id) on delete cascade,
  day     date not null,
  gb      numeric not null default 0 check (gb >= 0),
  primary key (user_id, day)
);

alter table public.usage_daily enable row level security;
drop policy if exists "Own daily usage" on public.usage_daily;
create policy "Own daily usage" on public.usage_daily for select using (auth.uid() = user_id);
revoke insert, update, delete on public.usage_daily from anon, authenticated;

-- p_rows: [{ "user_id": uuid, "gb": number }, ...] — GB consumed since the last
-- sync, credited to today's (UTC) bucket. Unknown users are skipped so one
-- deleted profile can never fail a whole batch.
create or replace function public.record_usage_deltas(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  with agg as (
    select (r->>'user_id')::uuid as user_id, sum((r->>'gb')::numeric) as gb
    from jsonb_array_elements(p_rows) r
    where (r->>'gb')::numeric > 0
    group by 1
  ), ins as (
    insert into public.usage_daily (user_id, day, gb)
    select a.user_id, (now() at time zone 'utc')::date, a.gb
    from agg a
    join public.profiles p on p.id = a.user_id
    on conflict (user_id, day) do update set gb = public.usage_daily.gb + excluded.gb
    returning 1
  )
  select count(*) into v_count from ins;
  return coalesce(v_count, 0);
end;
$$;

revoke all on function public.record_usage_deltas(jsonb) from public, anon, authenticated;
grant execute on function public.record_usage_deltas(jsonb) to service_role;

-- ── 4. used_gb keeps suspended sessions ───────────────────────
create or replace function public.recalculate_bandwidth_accounts()
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  update public.bandwidth_accounts ba
  set used_gb = coalesce(sub.total, 0) + ba.archived_used_gb
  from (
    select user_id, sum(gb_used) as total
    from public.proxy_credentials
    where status in ('active', 'suspended')
    group by user_id
  ) sub
  where ba.user_id = sub.user_id;

  update public.bandwidth_accounts ba
  set used_gb = archived_used_gb
  where used_gb <> archived_used_gb
    and not exists (
      select 1 from public.proxy_credentials pc
      where pc.user_id = ba.user_id and pc.status in ('active', 'suspended')
    );
end;
$$;

revoke all on function public.recalculate_bandwidth_accounts() from public, anon, authenticated;
grant execute on function public.recalculate_bandwidth_accounts() to service_role;

-- ── 5. Webhook events ─────────────────────────────────────────
-- COMPLETE list as of 0062 (0059's + bandwidth_debited) plus the three new ones.
alter table public.webhook_endpoints drop constraint if exists webhook_endpoints_valid_events;
alter table public.webhook_endpoints
  add constraint webhook_endpoints_valid_events
  check (event_types <@ array[
    'session_created', 'session_activated', 'session_deleted', 'session_topped_up',
    'session_released', 'session_low', 'session_exhausted',
    'session_suspended', 'session_resumed',
    'session_updated', 'session_password_rotated', 'whitelist_changed',
    'auto_topup_triggered', 'auto_topup_failed',
    'bandwidth_threshold_crossed', 'bandwidth_exhausted', 'bandwidth_credited', 'bandwidth_debited',
    'bandwidth_allocated', 'bandwidth_reclaimed', 'bandwidth_refunded',
    'api_key_created', 'api_key_revoked', 'api_key_expiring'
  ]::text[]);

insert into public.schema_migrations (filename) values
  ('0064_proxy_lifecycle_pass2.sql')
on conflict do nothing;

-- ============================================================
-- 0065 — Payments & billing close-out (audit section 3, round 3)
-- ============================================================
-- 1. orders.mismatch_alerted_at: a payment that does not match its order used
--    to e-mail the admin on EVERY look (each verify call, each hourly reconcile
--    for 3 days). The alert now fires once per order.
-- 2. Disputes: orders.dispute_status gains 'lost' (the dispute went against us
--    and the proportional bandwidth was taken back) and 'won'. Previously every
--    resolution was recorded as plain 'resolved' and nothing was clawed back.
-- 3. order_refunds records what was refunded in the currency the customer paid
--    in (charged_amount / charged_currency — M-Pesa credit notes can now state
--    the shillings) and where the refund came from (source: 'refund' | 'dispute').
-- 4. refund_requests: a customer asks for a refund from Billing; the admin sees
--    it (Admin -> Orders), then refunds it or declines it. The row closes itself
--    when the refund is applied.
-- 5. apply_order_refund() takes the extra arguments above (all optional, so the
--    three-argument call keeps working) and closes the customer's open request.
-- 6. protect_order_columns() pins mismatch_alerted_at against customer writes.
--
-- Run this BEFORE deploying the matching app code (the Paystack webhook now
-- passes the new apply_order_refund arguments).

-- ── 1. orders ───────────────────────────────────────────────
alter table public.orders add column if not exists mismatch_alerted_at timestamptz;

-- ── 2. dispute outcomes ─────────────────────────────────────
alter table public.orders drop constraint if exists orders_dispute_status_check;
alter table public.orders add constraint orders_dispute_status_check
  check (dispute_status is null or dispute_status in ('open', 'resolved', 'lost', 'won'));

-- ── 3. order_refunds ────────────────────────────────────────
alter table public.order_refunds add column if not exists charged_currency text;
alter table public.order_refunds add column if not exists charged_amount numeric;
alter table public.order_refunds add column if not exists source text not null default 'refund';

alter table public.order_refunds drop constraint if exists order_refunds_source_check;
alter table public.order_refunds add constraint order_refunds_source_check check (source in ('refund', 'dispute'));

-- ── 4. refund_requests ──────────────────────────────────────
create table if not exists public.refund_requests (
  id             uuid default uuid_generate_v4() primary key,
  order_id       uuid not null references public.orders(id) on delete cascade,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  reason         text not null check (char_length(reason) between 3 and 500),
  -- Computed by the server when the request is made: inside the 72-hour window
  -- of the refund policy with nothing used. Informational — an admin decides.
  within_policy  boolean not null default false,
  status         text not null default 'open' check (status in ('open', 'declined', 'refunded')),
  decline_note   text,
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz
);

create unique index if not exists refund_requests_one_open_per_order
  on public.refund_requests (order_id) where status = 'open';
create index if not exists refund_requests_user_idx on public.refund_requests (user_id, created_at desc);
create index if not exists refund_requests_open_idx on public.refund_requests (created_at) where status = 'open';

alter table public.refund_requests enable row level security;
-- Customers read their own requests; every write goes through the service role.
drop policy if exists "Own refund requests" on public.refund_requests;
create policy "Own refund requests" on public.refund_requests for select
  using (auth.uid() = user_id);

-- ── 6. protect_order_columns ────────────────────────────────
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

  new.user_id                      := old.user_id;
  new.plan_id                      := old.plan_id;
  new.gb_amount                    := old.gb_amount;
  new.amount_usd                   := old.amount_usd;
  new.payment_method               := old.payment_method;
  new.paystack_reference           := old.paystack_reference;
  new.bandwidth_credited           := old.bandwidth_credited;
  new.paid_at                      := old.paid_at;
  new.created_at                   := old.created_at;
  new.invoice_number               := old.invoice_number;
  new.failure_reason               := old.failure_reason;
  new.failed_at                    := old.failed_at;
  new.is_canary                    := old.is_canary;
  new.refunded_usd                 := old.refunded_usd;
  new.refunded_at                  := old.refunded_at;
  new.reconcile_checked_at         := old.reconcile_checked_at;
  new.post_credit_done_at          := old.post_credit_done_at;
  new.billing_details              := old.billing_details;
  new.dispute_status               := old.dispute_status;
  new.dispute_opened_at            := old.dispute_opened_at;
  new.dispute_resolution           := old.dispute_resolution;
  new.pay_currency                 := old.pay_currency;
  new.pay_amount                   := old.pay_amount;
  new.fx_rate                      := old.fx_rate;
  new.plan_slug                    := old.plan_slug;
  new.refund_requested_at          := old.refund_requested_at;
  new.billing_details_revision     := old.billing_details_revision;
  new.billing_details_updated_at   := old.billing_details_updated_at;
  new.mismatch_alerted_at          := old.mismatch_alerted_at;

  return new;
end;
$$;

-- ── 5. apply_order_refund ───────────────────────────────────
-- The old three-argument signature is replaced (a second overload would make a
-- named-argument call ambiguous).
drop function if exists public.apply_order_refund(uuid, text, numeric);

create or replace function public.apply_order_refund(
  p_order_id uuid,
  p_refund_reference text,
  p_refund_usd numeric,
  p_charged_amount numeric default null,
  p_charged_currency text default null,
  p_source text default 'refund'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order     public.orders%rowtype;
  v_credited  boolean;
  v_refund    numeric;
  v_gb        numeric;
  v_avail     numeric;
  v_claw      numeric;
  v_inserted  text;
  v_total     numeric;
  v_note      text;
  v_charged   numeric;
  v_source    text := case when p_source = 'dispute' then 'dispute' else 'refund' end;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('applied', false, 'reason', 'order_not_found');
  end if;

  -- Serialised by the order lock above, so a redelivered refund event is a
  -- clean no-op that does not burn a credit-note number.
  if exists (select 1 from public.order_refunds where refund_reference = p_refund_reference) then
    return jsonb_build_object('applied', false, 'reason', 'duplicate');
  end if;

  v_credited := v_order.bandwidth_credited is true;
  -- An uncredited order can still have been paid (webhook delayed): refunds
  -- against it are recorded. Anything else uncredited is not a real payment.
  if not v_credited and v_order.payment_status not in ('pending', 'cancelled', 'failed') then
    return jsonb_build_object('applied', false, 'reason', 'order_never_credited');
  end if;

  v_refund := least(p_refund_usd, v_order.amount_usd - v_order.refunded_usd);
  if v_refund is null or v_refund <= 0 then
    return jsonb_build_object('applied', false, 'reason', 'nothing_to_refund');
  end if;

  if v_credited then
    v_gb := round(v_order.gb_amount * v_refund / v_order.amount_usd, 6);
    select available_gb into v_avail
    from public.bandwidth_accounts where user_id = v_order.user_id for update;
    v_claw := least(v_gb, greatest(coalesce(v_avail, 0), 0));
  else
    v_gb := 0;
    v_claw := 0;
  end if;

  -- What was refunded in the customer's own currency, for the credit note. A
  -- refund capped above (it asked for more than was left) is scaled down with it.
  v_charged := case
    when p_charged_amount is null or p_charged_amount <= 0 then null
    when p_refund_usd > 0 and v_refund < p_refund_usd then round(p_charged_amount * v_refund / p_refund_usd, 2)
    else p_charged_amount
  end;

  v_note := 'CN-' || to_char(now() at time zone 'UTC', 'YYYY')
            || '-' || lpad(nextval('public.credit_note_seq')::text, 6, '0');

  insert into public.order_refunds (refund_reference, order_id, amount_usd, gb_clawed, gb_shortfall, credit_note_number, charged_amount, charged_currency, source)
  values (p_refund_reference, p_order_id, v_refund, v_claw, v_gb - v_claw, v_note,
          v_charged, case when v_charged is null then null else upper(p_charged_currency) end, v_source)
  on conflict (refund_reference) do nothing
  returning refund_reference into v_inserted;

  if v_inserted is null then
    return jsonb_build_object('applied', false, 'reason', 'duplicate');
  end if;

  if v_claw > 0 then
    update public.bandwidth_accounts
    set total_gb = total_gb - v_claw
    where user_id = v_order.user_id;
  end if;

  v_total := v_order.refunded_usd + v_refund;
  update public.orders
  set refunded_usd         = v_total,
      refunded_at          = now(),
      refund_requested_at  = null,
      payment_status       = case when v_total >= amount_usd then 'refunded' else payment_status end
  where id = p_order_id;

  -- The customer's open refund request (if any) is answered by this refund.
  update public.refund_requests
  set status = 'refunded', resolved_at = now()
  where order_id = p_order_id and status = 'open';

  return jsonb_build_object(
    'applied', true,
    'credited', v_credited,
    'refund_usd', v_refund,
    'gb_clawed', v_claw,
    'gb_shortfall', v_gb - v_claw,
    'fully_refunded', v_total >= v_order.amount_usd,
    'credit_note', v_note
  );
end;
$$;

revoke all on function public.apply_order_refund(uuid, text, numeric, numeric, text, text) from public, anon, authenticated;
grant execute on function public.apply_order_refund(uuid, text, numeric, numeric, text, text) to service_role;

insert into public.schema_migrations (filename) values
  ('0065_payments_billing_pass3.sql')
on conflict do nothing;

-- ============================================================
-- 0066_section7_reseller_affiliates_pass3.sql
-- ============================================================
-- 0066_section7_reseller_affiliates_pass3.sql
-- Reseller, affiliates & payouts — audit pass 3 close-out.
--
--  1. Commission CLAWBACK. A refund after a commission was paid out used to
--     write an audit row and nothing else, although the Terms (§6) say paid
--     commissions may be recovered. Now it records a negative adjustment that
--     the next payout cycle nets against the affiliate's new commissions.
--  2. Admin void: undo one commission, or confirm fraud on a referral and void
--     everything it earned (pending → void, already paid → clawback).
--  3. Self-referral / ring detection: every signup's IP hash is recorded, and a
--     referral is flagged when it shares an address with the REFERRER'S OWN
--     signup (the first alt account used to slip through), not only with the
--     referrer's other referrals.
--  4. A re-signup over an UNCONFIRMED address replaces the earlier attribution
--     (someone could attribute an email they don't own to their own code).
--  5. credit_referral_bonus refuses an order that was already refunded below
--     the qualifying minimum (a delayed retry used to credit a bonus that the
--     refund trigger, having already fired, could never reverse).
--  6. Per-campaign-tag click counts (the tag was stored per signup but clicks
--     were only counted per day), and a per-tag funnel.
--  7. Reseller INVITE-AND-CLAIM: allocating to an address with no account now
--     reserves the stock and e-mails an invitation; the GB lands when that
--     address signs up and confirms. Cancel / expire returns the stock.
--  8. Reseller low-stock alert settings.
--
-- All new functions are service-role only.

-- ── 1. Clawback ledger ─────────────────────────────────────────────────────
create table if not exists public.affiliate_adjustments (
  id            uuid default uuid_generate_v4() primary key,
  referrer_id   uuid not null references public.profiles(id) on delete cascade,
  commission_id uuid references public.affiliate_commissions(id) on delete set null,
  order_id      uuid references public.orders(id) on delete set null,
  amount_usd    numeric not null check (amount_usd < 0),
  reason        text not null check (reason in ('refund_after_paid', 'admin_void_paid')),
  created_at    timestamptz not null default now(),
  payout_id     uuid references public.affiliate_payouts(id) on delete set null, -- payout that absorbed it
  waived_at     timestamptz,
  waived_by     uuid references public.profiles(id) on delete set null
);
create index if not exists idx_affiliate_adjustments_open
  on public.affiliate_adjustments (referrer_id) where payout_id is null and waived_at is null;
create index if not exists idx_affiliate_adjustments_commission on public.affiliate_adjustments (commission_id);
alter table public.affiliate_adjustments enable row level security;
-- No policies: service role writes; affiliates read through my_affiliate_adjustments().

alter table public.affiliate_commissions add column if not exists voided_at timestamptz;
alter table public.affiliate_commissions add column if not exists void_reason text;

-- Refund → shrink an unpaid commission, or record a clawback for a paid one.
create or replace function public.reduce_commission_on_refund()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c record;
  v_ratio numeric;
  v_new numeric;
  v_delta numeric;
  v_payout_amt numeric;
  v_have numeric;
  v_deleted boolean;
begin
  if coalesce(new.refunded_usd, 0) <= coalesce(old.refunded_usd, 0) or coalesce(new.amount_usd, 0) <= 0 then
    return new;
  end if;

  v_ratio := least(new.refunded_usd / new.amount_usd, 1);

  select * into c from public.affiliate_commissions where order_id = new.id for update;
  if not found then
    return new;
  end if;

  v_new := case when v_ratio >= 1 then 0
                else round(c.gross_amount_usd * (1 - v_ratio) * c.commission_rate, 2) end;

  if c.status = 'paid' then
    -- Already paid out: record what must be recovered. Cumulative, so several
    -- partial refunds add up correctly and a repeat of the same refund adds 0.
    select coalesce(is_deleted, false) into v_deleted from public.profiles where id = c.referrer_id;
    select coalesce(-sum(amount_usd), 0) into v_have
    from public.affiliate_adjustments where commission_id = c.id and reason = 'refund_after_paid';
    v_delta := round((c.commission_amount_usd - v_new) - v_have, 2);
    if v_delta > 0 and not coalesce(v_deleted, false) and c.voided_at is null then
      insert into public.affiliate_adjustments (referrer_id, commission_id, order_id, amount_usd, reason)
      values (c.referrer_id, c.id, new.id, -v_delta, 'refund_after_paid');
    end if;
    insert into public.admin_audit_log (admin_id, action, target_user_id, target_ref, details)
    values (null, 'commission_refund_after_paid', c.referrer_id, new.id::text,
            jsonb_build_object('commission_id', c.id, 'commission_amount_usd', c.commission_amount_usd,
                               'clawback_usd', greatest(v_delta, 0),
                               'order_refunded_usd', new.refunded_usd, 'order_amount_usd', new.amount_usd));
    return new;
  end if;

  if c.status <> 'pending' then
    return new; -- void already
  end if;

  v_delta := c.commission_amount_usd - v_new;
  if v_delta <= 0 then
    return new;
  end if;

  update public.affiliate_commissions
  set commission_amount_usd = v_new,
      status = case when v_new = 0 then 'void' else status end
  where id = c.id;

  if c.payout_id is not null then
    update public.affiliate_payouts
    set amount_usd = greatest(amount_usd - v_delta, 0)
    where id = c.payout_id and status = 'pending'
    returning amount_usd into v_payout_amt;

    -- Nothing left to pay: drop the empty payout (the FK nulls the link on any
    -- remaining commission / adjustment rows) so it can't be "marked paid" for
    -- $0 and the (referrer, cycle) slot is free again.
    if found and v_payout_amt <= 0 then
      delete from public.affiliate_payouts where id = c.payout_id;
      insert into public.admin_audit_log (admin_id, action, target_user_id, target_ref, details)
      values (null, 'payout_emptied_by_refund', c.referrer_id, c.payout_id::text,
              jsonb_build_object('order_id', new.id, 'order_refunded_usd', new.refunded_usd));
    end if;
  end if;

  return new;
end;
$$;

-- Payout cycle: clawbacks are netted against the new commissions. An affiliate
-- whose commissions don't cover their clawback simply rolls over.
create or replace function public.run_affiliate_payout_cycle(
  p_cycle_start date,
  p_cycle_end date,
  p_min_payout_usd numeric default 20,
  p_hold_hours integer default 48
)
returns table (
  out_referrer_id uuid,
  out_status text,
  out_amount_usd numeric,
  out_payout_id uuid
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
  v_status text;
  v_new_payout_id uuid;
  v_method text;
  v_method_updated timestamptz;
  v_wallet_address text;
  v_wallet_network text;
  v_bank jsonb;
  v_mpesa_phone text;
  v_affiliate_status text;
  v_deleted boolean;
  v_suspended boolean;
  v_claimed_total numeric;
  v_adj_open numeric;
  v_adj_claimed numeric;
  v_net numeric;
begin
  for r in
    select ac.referrer_id as rid, sum(ac.commission_amount_usd) as total
    from public.affiliate_commissions ac
    where ac.payout_id is null
      and ac.status = 'pending'
      and ac.created_at::date <= p_cycle_end
    group by ac.referrer_id
  loop
    select payout_method, payout_method_updated_at, payout_wallet_address, payout_wallet_network,
           payout_bank_details, payout_mpesa_phone, affiliate_status, is_deleted, is_suspended
      into v_method, v_method_updated, v_wallet_address, v_wallet_network,
           v_bank, v_mpesa_phone, v_affiliate_status, v_deleted, v_suspended
    from public.profiles where id = r.rid;

    select coalesce(-sum(amount_usd), 0) into v_adj_open
    from public.affiliate_adjustments
    where referrer_id = r.rid and payout_id is null and waived_at is null;
    v_net := r.total - v_adj_open;

    if coalesce(v_deleted, false) or coalesce(v_suspended, false) or v_affiliate_status is distinct from 'approved' then
      v_status := 'ineligible';
    elsif v_method is null then
      v_status := 'no_payout_method';
    elsif v_method_updated is null or v_method_updated > (now() - (p_hold_hours || ' hours')::interval) then
      v_status := 'held_recent_method';
    elsif v_net < p_min_payout_usd or v_net <= 0 then
      v_status := 'below_minimum';
    else
      v_status := 'created';
    end if;

    v_new_payout_id := null;
    out_amount_usd := v_net;

    if v_status = 'created' then
      insert into public.affiliate_payouts
        (referrer_id, cycle_start, cycle_end, amount_usd, status,
         payout_method, payout_wallet_address, payout_wallet_network, payout_bank_details, payout_mpesa_phone)
      values
        (r.rid, p_cycle_start, p_cycle_end, v_net, 'pending',
         v_method, v_wallet_address, v_wallet_network, v_bank, v_mpesa_phone)
      on conflict (referrer_id, cycle_start, cycle_end) do nothing
      returning id into v_new_payout_id;

      if v_new_payout_id is not null then
        -- Claim first, then size the payout from what was really claimed.
        with claimed as (
          update public.affiliate_commissions
          set payout_id = v_new_payout_id
          where referrer_id = r.rid
            and payout_id is null
            and status = 'pending'
            and created_at::date <= p_cycle_end
          returning commission_amount_usd
        )
        select coalesce(sum(commission_amount_usd), 0) into v_claimed_total from claimed;

        with adj as (
          update public.affiliate_adjustments
          set payout_id = v_new_payout_id
          where referrer_id = r.rid and payout_id is null and waived_at is null
          returning amount_usd
        )
        select coalesce(sum(amount_usd), 0) into v_adj_claimed from adj; -- negative

        v_net := v_claimed_total + v_adj_claimed;
        if v_net <= 0 then
          -- A refund landed between the check and the claim. Undo: the FKs
          -- release the commissions and adjustments for the next cycle.
          delete from public.affiliate_payouts where id = v_new_payout_id;
          v_new_payout_id := null;
          v_status := 'below_minimum';
        elsif v_net is distinct from (r.total - v_adj_open) then
          update public.affiliate_payouts set amount_usd = v_net where id = v_new_payout_id;
        end if;
        out_amount_usd := v_net;
      else
        v_status := 'already_run';
      end if;
    end if;

    out_referrer_id := r.rid;
    out_status := v_status;
    out_payout_id := v_new_payout_id;
    return next;
  end loop;
end;
$$;
revoke all on function public.run_affiliate_payout_cycle(date, date, numeric, integer) from public, anon, authenticated;
grant execute on function public.run_affiliate_payout_cycle(date, date, numeric, integer) to service_role;

-- ── 2. Admin void / fraud confirmation with money consequences ─────────────
create or replace function public.admin_void_commission(p_commission_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.affiliate_commissions%rowtype;
  v_reason text := nullif(left(trim(coalesce(p_reason, '')), 300), '');
  v_payout_amt numeric;
  v_have numeric;
  v_owe numeric;
  v_deleted boolean;
begin
  select * into c from public.affiliate_commissions where id = p_commission_id for update;
  if not found or c.status = 'void' or c.voided_at is not null then
    return null;
  end if;

  if c.status = 'pending' then
    update public.affiliate_commissions
    set status = 'void', voided_at = now(), void_reason = v_reason
    where id = c.id;
    if c.payout_id is not null then
      update public.affiliate_payouts
      set amount_usd = greatest(amount_usd - c.commission_amount_usd, 0)
      where id = c.payout_id and status = 'pending'
      returning amount_usd into v_payout_amt;
      if found and v_payout_amt <= 0 then
        delete from public.affiliate_payouts where id = c.payout_id;
      end if;
    end if;
    return jsonb_build_object('action', case when c.payout_id is null then 'voided' else 'voided_from_payout' end,
                              'referrer_id', c.referrer_id, 'amount_usd', c.commission_amount_usd);
  end if;

  -- Paid: the money is gone; recover what hasn't already been clawed back.
  select coalesce(-sum(amount_usd), 0) into v_have from public.affiliate_adjustments where commission_id = c.id;
  v_owe := round(c.commission_amount_usd - v_have, 2);
  select coalesce(is_deleted, false) into v_deleted from public.profiles where id = c.referrer_id;
  update public.affiliate_commissions set voided_at = now(), void_reason = v_reason where id = c.id;
  if v_owe > 0 and not coalesce(v_deleted, false) then
    insert into public.affiliate_adjustments (referrer_id, commission_id, order_id, amount_usd, reason)
    values (c.referrer_id, c.id, c.order_id, -v_owe, 'admin_void_paid');
  end if;
  return jsonb_build_object('action', 'clawback_recorded', 'referrer_id', c.referrer_id, 'amount_usd', greatest(v_owe, 0));
end;
$$;
revoke all on function public.admin_void_commission(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_void_commission(uuid, text) to service_role;

-- Flag (if not already), confirm as fraud, and void everything the referral
-- earned. Returns the summed effect, or null for an unknown referral.
create or replace function public.admin_void_referral_earnings(p_referral_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  rf public.referrals%rowtype;
  cid uuid;
  res jsonb;
  v_voided integer := 0;
  v_clawed integer := 0;
  v_usd numeric := 0;
begin
  select * into rf from public.referrals where id = p_referral_id for update;
  if not found then
    return null;
  end if;

  update public.referrals
  set flagged = true,
      flag_reason = coalesce(flag_reason, 'admin_flagged'),
      flag_confirmed_at = coalesce(flag_confirmed_at, now())
  where id = rf.id;

  for cid in select id from public.affiliate_commissions where referral_id = rf.id and status <> 'void' and voided_at is null loop
    res := public.admin_void_commission(cid, p_reason);
    if res is not null then
      v_usd := v_usd + coalesce((res ->> 'amount_usd')::numeric, 0);
      if res ->> 'action' = 'clawback_recorded' then v_clawed := v_clawed + 1; else v_voided := v_voided + 1; end if;
    end if;
  end loop;
  return jsonb_build_object('referrer_id', rf.referrer_id, 'voided', v_voided, 'clawbacks', v_clawed, 'amount_usd', v_usd);
end;
$$;
revoke all on function public.admin_void_referral_earnings(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_void_referral_earnings(uuid, text) to service_role;

create or replace function public.admin_waive_adjustment(p_adjustment_id uuid, p_admin_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a public.affiliate_adjustments%rowtype;
begin
  update public.affiliate_adjustments
  set waived_at = now(), waived_by = p_admin_id
  where id = p_adjustment_id and payout_id is null and waived_at is null
  returning * into a;
  if not found then return null; end if;
  return jsonb_build_object('referrer_id', a.referrer_id, 'amount_usd', a.amount_usd);
end;
$$;
revoke all on function public.admin_waive_adjustment(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_waive_adjustment(uuid, uuid) to service_role;

-- What the affiliate sees: every clawback, whether it has been netted yet.
create or replace function public.my_affiliate_adjustments(p_user_id uuid)
returns table (
  id uuid, amount_usd numeric, reason text, created_at timestamptz, settled boolean, waived boolean
) language sql stable security definer set search_path = public, pg_temp as $$
  select a.id, a.amount_usd, a.reason, a.created_at, a.payout_id is not null, a.waived_at is not null
  from public.affiliate_adjustments a
  where a.referrer_id = p_user_id
  order by a.created_at desc
  limit 50;
$$;
revoke all on function public.my_affiliate_adjustments(uuid) from public, anon, authenticated;
grant execute on function public.my_affiliate_adjustments(uuid) to service_role;

-- ── 3. Signup IP record + stronger self-referral flag ──────────────────────
create table if not exists public.signup_ip_hashes (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  ip_hash    text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_signup_ip_hashes_hash on public.signup_ip_hashes (ip_hash);
alter table public.signup_ip_hashes enable row level security;
-- No policies: service role only (it is evidence a user must not be able to edit).

create or replace function public.record_signup_ip(p_user_id uuid, p_ip_hash text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_user_id is null or p_ip_hash is null then return; end if;
  insert into public.signup_ip_hashes (user_id, ip_hash)
  select p_user_id, p_ip_hash where exists (select 1 from public.profiles where id = p_user_id)
  on conflict (user_id) do nothing;
end;
$$;
revoke all on function public.record_signup_ip(uuid, text) from public, anon, authenticated;
grant execute on function public.record_signup_ip(uuid, text) to service_role;

create or replace function public.record_referral_signup(
  p_code        text,
  p_new_user_id uuid,
  p_sub_id      text default null,
  p_ip_hash     text default null
)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_code        text;
  v_referrer_id uuid;
  v_ref_email   text;
  v_new_email   text;
  v_deleted     boolean;
  v_suspended   boolean;
  v_flagged     boolean := false;
  v_flag_reason text;
  v_sub         text;
  v_signup_hash text;
  v_hashes      text[];
begin
  if p_code is null or p_new_user_id is null then
    return 'ignored';
  end if;
  v_code := upper(trim(p_code));
  if v_code = '' or length(v_code) > 32 then
    return 'invalid_code';
  end if;

  if exists (select 1 from public.referrals where referred_user_id = p_new_user_id) then
    return 'already_referred';
  end if;

  select id, email, is_deleted, is_suspended
    into v_referrer_id, v_ref_email, v_deleted, v_suspended
  from public.profiles where referral_code = v_code;

  if v_referrer_id is null then
    return 'invalid_code';
  end if;
  if v_referrer_id = p_new_user_id then
    return 'self_referral';
  end if;
  if coalesce(v_deleted, false) or coalesce(v_suspended, false) then
    return 'referrer_inactive';
  end if;

  select email into v_new_email from public.profiles where id = p_new_user_id;
  if v_new_email is null then
    return 'ignored';
  end if;
  if public.normalize_email_alias(v_new_email) = public.normalize_email_alias(v_ref_email) then
    return 'self_referral'; -- gmail dots / +tag alias of the referrer's own address
  end if;

  -- Every address this account is known to have used: the one on this request
  -- (a claim happens later, from wherever the user is now) and the one it signed
  -- up from.
  select ip_hash into v_signup_hash from public.signup_ip_hashes where user_id = p_new_user_id;
  v_hashes := array_remove(array[p_ip_hash, v_signup_hash], null);

  if coalesce(array_length(v_hashes, 1), 0) > 0 then
    if exists (
      select 1 from public.referrals
      where referrer_id = v_referrer_id and signup_ip_hash = any (v_hashes)
    ) then
      v_flagged := true;
      v_flag_reason := 'shared_signup_ip';
    elsif exists (
      -- The referrer's OWN signup address. The first alt account (and any
      -- A→B→C chain) never shared an address with another of the referrer's
      -- referrals, so the check above could not see it.
      select 1 from public.signup_ip_hashes where user_id = v_referrer_id and ip_hash = any (v_hashes)
    ) or exists (
      select 1 from public.referrals where referred_user_id = v_referrer_id and signup_ip_hash = any (v_hashes)
    ) then
      v_flagged := true;
      v_flag_reason := 'same_ip_as_referrer';
    end if;
  end if;

  v_sub := nullif(left(regexp_replace(coalesce(p_sub_id, ''), '[^A-Za-z0-9_-]', '', 'g'), 32), '');

  insert into public.referrals (referrer_id, referred_user_id, code_used, sub_id, signup_ip_hash, flagged, flag_reason)
  values (v_referrer_id, p_new_user_id, v_code, v_sub, coalesce(p_ip_hash, v_signup_hash), v_flagged, v_flag_reason)
  on conflict (referred_user_id) do nothing;

  return case when v_flagged then 'recorded_flagged' else 'recorded' end;
end;
$$;

-- ── 4. Re-signup over an unconfirmed address replaces the attribution ──────
create or replace function public.reset_unconfirmed_referral(p_user_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_n integer;
begin
  if not exists (select 1 from auth.users where id = p_user_id and email_confirmed_at is null) then
    return false;
  end if;
  delete from public.referrals r
  where r.referred_user_id = p_user_id
    and r.gb_bonus_credited_at is null
    and not exists (select 1 from public.affiliate_commissions c where c.referral_id = r.id);
  get diagnostics v_n = row_count;
  delete from public.signup_ip_hashes where user_id = p_user_id;
  return v_n > 0;
end;
$$;
revoke all on function public.reset_unconfirmed_referral(uuid) from public, anon, authenticated;
grant execute on function public.reset_unconfirmed_referral(uuid) to service_role;

-- ── 5. Bonus after refund ──────────────────────────────────────────────────
create or replace function public.credit_referral_bonus(
  p_referral_id      uuid,
  p_gb               numeric,
  p_order_amount_usd numeric default null,
  p_min_order_usd    numeric default 0,
  p_order_id         uuid default null
)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_referrer_id uuid;
  v_referred_id uuid;
  v_claimed     uuid;
begin
  update public.referrals r
  set gb_bonus_credited_at = now(), gb_bonus_amount = p_gb,
      gb_bonus_order_id = p_order_id, gb_bonus_min_usd = p_min_order_usd
  from public.profiles pr
  where r.id = p_referral_id
    and r.gb_bonus_credited_at is null
    and r.flagged = false
    and pr.id = r.referrer_id
    and not coalesce(pr.is_deleted, false)
    and not coalesce(pr.is_suspended, false)
    and (p_order_amount_usd is null or p_order_amount_usd >= p_min_order_usd)
    -- The refund trigger only fires when refunded_usd RISES. An order refunded
    -- before this (retried) credit ran would otherwise earn a bonus nothing
    -- could ever take back — same qualifying rule as reverse_referral_bonus_on_refund.
    and (p_order_id is null or not exists (
      select 1 from public.orders o
      where o.id = p_order_id
        and (coalesce(o.amount_usd, 0) - coalesce(o.refunded_usd, 0) <= 0
             or coalesce(o.amount_usd, 0) - coalesce(o.refunded_usd, 0) < p_min_order_usd)
    ))
  returning r.id, r.referrer_id, r.referred_user_id into v_claimed, v_referrer_id, v_referred_id;

  if v_claimed is null then
    return false;
  end if;

  perform public.credit_bandwidth(v_referrer_id, p_gb);
  perform public.credit_bandwidth(v_referred_id, p_gb);
  return true;
end;
$$;

-- ── 6. Per-tag clicks ──────────────────────────────────────────────────────
create table if not exists public.referral_tag_clicks (
  referrer_id uuid not null references public.profiles(id) on delete cascade,
  sub_id      text not null,
  day         date not null,
  clicks      integer not null default 0,
  primary key (referrer_id, sub_id, day)
);
alter table public.referral_tag_clicks enable row level security;

drop function if exists public.record_referral_click(text);
create or replace function public.record_referral_click(p_code text, p_sub_id text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id  uuid;
  v_sub text := nullif(left(regexp_replace(coalesce(p_sub_id, ''), '[^A-Za-z0-9_-]', '', 'g'), 32), '');
  v_day date := (now() at time zone 'UTC')::date;
begin
  select id into v_id from public.profiles
  where referral_code = upper(trim(coalesce(p_code, ''))) and not coalesce(is_deleted, false);
  if v_id is null then return; end if;

  insert into public.referral_clicks (referrer_id, day, clicks)
  values (v_id, v_day, 1)
  on conflict (referrer_id, day) do update set clicks = public.referral_clicks.clicks + 1;

  if v_sub is not null then
    -- Bound the number of distinct tags one code can create (the tag is free
    -- text in a public link, so it must not be a way to bloat this table).
    if exists (select 1 from public.referral_tag_clicks where referrer_id = v_id and sub_id = v_sub)
       or (select count(distinct sub_id) from public.referral_tag_clicks where referrer_id = v_id) < 100 then
      insert into public.referral_tag_clicks (referrer_id, sub_id, day, clicks)
      values (v_id, v_sub, v_day, 1)
      on conflict (referrer_id, sub_id, day) do update set clicks = public.referral_tag_clicks.clicks + 1;
    end if;
  end if;
end;
$$;
revoke all on function public.record_referral_click(text, text) from public, anon, authenticated;
grant execute on function public.record_referral_click(text, text) to service_role;

create or replace function public.my_referral_tags(p_user_id uuid)
returns table (
  sub_id text, clicks bigint, signups bigint, converted bigint, earned_usd numeric
) language sql stable security definer set search_path = public, pg_temp as $$
  with tags as (
    select t.sub_id from public.referral_tag_clicks t where t.referrer_id = p_user_id
    union
    select r.sub_id from public.referrals r where r.referrer_id = p_user_id and r.sub_id is not null
  ),
  clk as (
    select t.sub_id, sum(t.clicks) as clicks from public.referral_tag_clicks t
    where t.referrer_id = p_user_id group by t.sub_id
  ),
  sig as (
    select r.sub_id,
           count(*) as signups,
           count(*) filter (where r.gb_bonus_credited_at is not null
                            or exists (select 1 from public.affiliate_commissions x where x.referral_id = r.id)) as converted,
           coalesce(sum((select coalesce(sum(c.commission_amount_usd), 0) from public.affiliate_commissions c
                         where c.referral_id = r.id and c.status <> 'void')), 0) as earned
    from public.referrals r where r.referrer_id = p_user_id and r.sub_id is not null and not r.flagged
    group by r.sub_id
  )
  select tags.sub_id, coalesce(clk.clicks, 0)::bigint, coalesce(sig.signups, 0)::bigint,
         coalesce(sig.converted, 0)::bigint, coalesce(sig.earned, 0)
  from tags
  left join clk on clk.sub_id = tags.sub_id
  left join sig on sig.sub_id = tags.sub_id
  order by coalesce(sig.earned, 0) desc, coalesce(clk.clicks, 0) desc, tags.sub_id
  limit 100;
$$;
revoke all on function public.my_referral_tags(uuid) from public, anon, authenticated;
grant execute on function public.my_referral_tags(uuid) to service_role;

-- ── 7. Reseller invite-and-claim ───────────────────────────────────────────
create table if not exists public.reseller_pending_transfers (
  id              uuid default uuid_generate_v4() primary key,
  reseller_id     uuid not null references public.profiles(id) on delete cascade,
  recipient_email text not null check (recipient_email = lower(recipient_email) and length(recipient_email) <= 254),
  gb_amount       numeric not null check (gb_amount >= 0.1),
  note            text,
  status          text not null default 'pending' check (status in ('pending', 'claimed', 'cancelled', 'expired')),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '30 days',
  resolved_at     timestamptz,
  claimed_by      uuid references public.profiles(id) on delete set null,
  transfer_id     uuid references public.reseller_transfers(id) on delete set null,
  notified_at     timestamptz -- when the resolution (claimed / expired) e-mails + webhooks went out
);
create unique index if not exists uq_reseller_pending_open
  on public.reseller_pending_transfers (reseller_id, recipient_email) where status = 'pending';
create index if not exists idx_reseller_pending_email
  on public.reseller_pending_transfers (recipient_email) where status = 'pending';
create index if not exists idx_reseller_pending_reseller on public.reseller_pending_transfers (reseller_id, created_at desc);
alter table public.reseller_pending_transfers enable row level security;
-- No policies: service role only (the invited address is not a user yet).

-- Reserves stock exactly like a live allocation (allocated_gb), so the
-- reseller's available figure is right immediately and no other transfer can
-- spend it. Same lock order as the rest of the reseller functions.
create or replace function public.create_pending_reseller_transfer(
  p_reseller_id uuid, p_email text, p_gb numeric, p_note text default null
)
returns table (out_pending_id uuid, out_total_gb numeric, out_expires_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_email   text := lower(trim(coalesce(p_email, '')));
  v_own     text;
  v_updated numeric;
  v_open    integer;
  v_id      uuid;
  v_total   numeric;
  v_exp     timestamptz;
begin
  if p_gb is null or p_gb < 0.1 then raise exception 'Minimum allocation is 0.1 GB'; end if;
  if p_gb <> round(p_gb, 3) then raise exception 'At most 3 decimal places are allowed'; end if;
  if p_gb > 1000000 then raise exception 'Amount too large'; end if;
  if v_email = '' or v_email not like '%@%' or length(v_email) > 254 then raise exception 'A valid recipient email is required'; end if;

  select email into v_own from public.profiles where id = p_reseller_id;
  if v_own is not null and public.normalize_email_alias(v_own) = public.normalize_email_alias(v_email) then
    raise exception 'Cannot allocate bandwidth to yourself';
  end if;

  perform 1 from public.bandwidth_accounts where user_id = p_reseller_id for update;

  select count(*) into v_open from public.reseller_pending_transfers
  where reseller_id = p_reseller_id and status = 'pending';
  if v_open >= 100 and not exists (
    select 1 from public.reseller_pending_transfers where reseller_id = p_reseller_id and recipient_email = v_email and status = 'pending'
  ) then
    raise exception 'Too many open invitations — cancel some or wait for them to be claimed.';
  end if;

  update public.bandwidth_accounts
  set allocated_gb = allocated_gb + p_gb
  where user_id = p_reseller_id and (total_gb - allocated_gb) >= p_gb
  returning allocated_gb into v_updated;
  if v_updated is null then
    raise exception 'Not enough bandwidth in your stock.' using errcode = 'P0001';
  end if;

  insert into public.reseller_pending_transfers (reseller_id, recipient_email, gb_amount, note)
  values (p_reseller_id, v_email, p_gb, nullif(left(trim(coalesce(p_note, '')), 200), ''))
  on conflict (reseller_id, recipient_email) where status = 'pending'
  do update set gb_amount = public.reseller_pending_transfers.gb_amount + excluded.gb_amount,
                note = coalesce(excluded.note, public.reseller_pending_transfers.note),
                expires_at = now() + interval '30 days'
  returning id, gb_amount, expires_at into v_id, v_total, v_exp;

  return query select v_id, v_total, v_exp;
end;
$$;
revoke all on function public.create_pending_reseller_transfer(uuid, text, numeric, text) from public, anon, authenticated;
grant execute on function public.create_pending_reseller_transfer(uuid, text, numeric, text) to service_role;

-- Called once the address is a confirmed, active account. The stock was
-- reserved at invite time, so only the recipient's side moves here.
create or replace function public.claim_pending_reseller_transfers(p_user_id uuid)
returns table (out_transfer_id uuid, out_reseller_id uuid, out_gb numeric)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_email text;
  v_ok    boolean;
  p       record;
  v_tid   uuid;
begin
  select lower(pr.email), (u.email_confirmed_at is not null)
         and not coalesce(pr.is_deleted, false) and not coalesce(pr.is_suspended, false)
    into v_email, v_ok
  from public.profiles pr join auth.users u on u.id = pr.id
  where pr.id = p_user_id;
  if v_email is null or not coalesce(v_ok, false) then return; end if;

  for p in
    select * from public.reseller_pending_transfers
    where recipient_email = v_email and status = 'pending' and expires_at > now() and reseller_id <> p_user_id
    order by created_at for update
  loop
    perform 1 from public.bandwidth_accounts where user_id = p_user_id for update;
    insert into public.bandwidth_accounts (user_id, total_gb, used_gb, allocated_gb)
    values (p_user_id, p.gb_amount, 0, 0)
    on conflict (user_id) do update set total_gb = public.bandwidth_accounts.total_gb + excluded.total_gb;

    insert into public.reseller_transfers (reseller_id, recipient_id, gb_amount, status, activated_at, note)
    values (p.reseller_id, p_user_id, p.gb_amount, 'active', now(), p.note)
    returning id into v_tid;

    update public.reseller_pending_transfers
    set status = 'claimed', resolved_at = now(), claimed_by = p_user_id, transfer_id = v_tid
    where id = p.id;

    out_transfer_id := v_tid; out_reseller_id := p.reseller_id; out_gb := p.gb_amount;
    return next;
  end loop;
end;
$$;
revoke all on function public.claim_pending_reseller_transfers(uuid) from public, anon, authenticated;
grant execute on function public.claim_pending_reseller_transfers(uuid) to service_role;

create or replace function public.cancel_pending_reseller_transfer(p_id uuid, p_reseller_id uuid)
returns numeric language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p public.reseller_pending_transfers%rowtype;
begin
  -- Lock order matches create_pending_reseller_transfer: the reseller's stock
  -- row FIRST, then the invitation row (the other order can deadlock with a
  -- top-up of the same invitation).
  perform 1 from public.bandwidth_accounts where user_id = p_reseller_id for update;
  select * into p from public.reseller_pending_transfers
  where id = p_id and reseller_id = p_reseller_id and status = 'pending' for update;
  if not found then return null; end if;
  update public.bandwidth_accounts set allocated_gb = greatest(allocated_gb - p.gb_amount, 0) where user_id = p.reseller_id;
  update public.reseller_pending_transfers set status = 'cancelled', resolved_at = now() where id = p.id;
  return p.gb_amount;
end;
$$;
revoke all on function public.cancel_pending_reseller_transfer(uuid, uuid) from public, anon, authenticated;
grant execute on function public.cancel_pending_reseller_transfer(uuid, uuid) to service_role;

-- Claim at the moment an address becomes a CONFIRMED account — in the database,
-- so it happens however the confirmation link was opened (the /auth/callback
-- PKCE exchange only works in the browser that asked for it). A failure here
-- must never block the confirmation itself. The e-mails and webhooks follow
-- from the notification sweep (notified_at is null).
create or replace function public.claim_pending_on_confirm()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  begin
    perform public.claim_pending_reseller_transfers(new.id);
  exception when others then
    raise warning 'claim_pending_reseller_transfers failed for %: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function public.claim_pending_on_confirm() from public, anon, authenticated;

drop trigger if exists trg_claim_pending_on_confirm on auth.users;
create trigger trg_claim_pending_on_confirm
  after update of email_confirmed_at on auth.users
  for each row when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function public.claim_pending_on_confirm();

-- Accounts created already-confirmed. Named so it fires after the profile row
-- is created by on_auth_user_created (AFTER triggers run in name order).
drop trigger if exists z_claim_pending_on_insert on auth.users;
create trigger z_claim_pending_on_insert
  after insert on auth.users
  for each row when (new.email_confirmed_at is not null)
  execute function public.claim_pending_on_confirm();

-- Cron: unclaimed invitations give the stock back; old resolved rows (which
-- hold an e-mail address that never became a customer) are deleted.
create or replace function public.expire_pending_reseller_transfers()
returns table (out_reseller_id uuid, out_email text, out_gb numeric)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c record;
  p public.reseller_pending_transfers%rowtype;
begin
  for c in
    select id, reseller_id from public.reseller_pending_transfers
    where status = 'pending' and expires_at <= now() order by reseller_id, created_at limit 200
  loop
    -- Stock row first, then the invitation (see cancel_pending_reseller_transfer).
    perform 1 from public.bandwidth_accounts where user_id = c.reseller_id for update;
    select * into p from public.reseller_pending_transfers
    where id = c.id and status = 'pending' and expires_at <= now() for update skip locked;
    if not found then continue; end if; -- claimed / cancelled / topped up since
    update public.bandwidth_accounts set allocated_gb = greatest(allocated_gb - p.gb_amount, 0) where user_id = p.reseller_id;
    update public.reseller_pending_transfers set status = 'expired', resolved_at = now() where id = p.id;
    out_reseller_id := p.reseller_id; out_email := p.recipient_email; out_gb := p.gb_amount;
    return next;
  end loop;
  delete from public.reseller_pending_transfers where status <> 'pending' and resolved_at < now() - interval '90 days';
end;
$$;
revoke all on function public.expire_pending_reseller_transfers() from public, anon, authenticated;
grant execute on function public.expire_pending_reseller_transfers() to service_role;

-- ── 7b. Account deletion ───────────────────────────────────────────────────
-- A deleted account must not leave its signup-address hash behind, and a
-- deleted reseller's open invitations (which hold invitees' e-mail addresses)
-- are closed; their reserved stock is moot with the account gone.
create or replace function public.cleanup_section7_on_delete()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from public.signup_ip_hashes where user_id = new.id;
  update public.reseller_pending_transfers
  set status = 'cancelled', resolved_at = now(), notified_at = now()
  where reseller_id = new.id and status = 'pending';
  return null;
end;
$$;
revoke all on function public.cleanup_section7_on_delete() from public, anon, authenticated;
drop trigger if exists trg_cleanup_section7_on_delete on public.profiles;
create trigger trg_cleanup_section7_on_delete
  after update of is_deleted on public.profiles
  for each row when (new.is_deleted is true and old.is_deleted is distinct from true)
  execute function public.cleanup_section7_on_delete();

-- ── 8. Reseller low-stock alert ────────────────────────────────────────────
alter table public.profiles add column if not exists reseller_low_stock_gb numeric
  check (reseller_low_stock_gb is null or (reseller_low_stock_gb >= 0 and reseller_low_stock_gb <= 1000000));
alter table public.profiles add column if not exists reseller_low_stock_alerted_at timestamptz;

-- Re-arms an alert once stock is back above the threshold (or the setting is
-- cleared), then returns the resellers who are low and haven't been told.
create or replace function public.reseller_low_stock_due()
returns table (out_reseller_id uuid, out_email text, out_name text, out_available_gb numeric, out_threshold_gb numeric)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.profiles p set reseller_low_stock_alerted_at = null
  where p.reseller_low_stock_alerted_at is not null
    and (p.reseller_low_stock_gb is null
         or coalesce((select b.available_gb from public.bandwidth_accounts b where b.user_id = p.id), 0) >= p.reseller_low_stock_gb);

  return query
  select p.id, p.email, p.full_name, coalesce(b.available_gb, 0), p.reseller_low_stock_gb
  from public.profiles p
  left join public.bandwidth_accounts b on b.user_id = p.id
  where p.role = 'reseller' and p.reseller_low_stock_gb is not null
    and coalesce(p.is_deleted, false) = false and coalesce(p.is_suspended, false) = false
    and coalesce(b.available_gb, 0) < p.reseller_low_stock_gb
    and p.reseller_low_stock_alerted_at is null;
end;
$$;
revoke all on function public.reseller_low_stock_due() from public, anon, authenticated;
grant execute on function public.reseller_low_stock_due() to service_role;

insert into public.schema_migrations (filename) values
  ('0066_section7_reseller_affiliates_pass3.sql')
on conflict do nothing;

-- ============================================================
-- 0067_admin_section8_closeout.sql
-- ============================================================
-- 0067_admin_section8_closeout.sql
-- Admin & Verified Operators — audit close-out.
--
--  1. admin_audit_log becomes tamper-resistant. The table was "append-only by
--     convention" only: anything holding the service role (every admin route,
--     any leaked key) could rewrite or delete the record of what admins did.
--     A trigger now rejects DELETE, TRUNCATE and any UPDATE — except the one
--     the foreign keys themselves perform (ON DELETE SET NULL nulling admin_id /
--     target_user_id when a profile row is hard-deleted), which changes nothing
--     else on the row.
--  2. admin_affiliate_earnings() takes an optional list of affiliate ids. The
--     no-argument version returned one row per affiliate that has ever earned,
--     which PostgREST silently cut off at 1000 rows — beyond that the admin
--     affiliate pages showed $0 for affiliates it dropped. The pages now ask
--     only for the affiliates they are displaying.
--
-- Safe to run against the live DB: idempotent.

-- ── 1. Audit log is append-only ─────────────────────────────
create or replace function public.admin_audit_log_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE'
     and new.id         is not distinct from old.id
     and new.action     is not distinct from old.action
     and new.target_ref is not distinct from old.target_ref
     and new.details    is not distinct from old.details
     and new.created_at is not distinct from old.created_at
     -- only the FK "set null" action: a reference may go to NULL, never change
     and (new.admin_id        is not distinct from old.admin_id        or new.admin_id        is null)
     and (new.target_user_id  is not distinct from old.target_user_id  or new.target_user_id  is null)
  then
    return new;
  end if;
  raise exception 'admin_audit_log is append-only (% refused)', tg_op using errcode = '42501';
end;
$$;

drop trigger if exists admin_audit_log_no_change on public.admin_audit_log;
create trigger admin_audit_log_no_change
  before update or delete on public.admin_audit_log
  for each row execute function public.admin_audit_log_guard();

drop trigger if exists admin_audit_log_no_truncate on public.admin_audit_log;
create trigger admin_audit_log_no_truncate
  before truncate on public.admin_audit_log
  for each statement execute function public.admin_audit_log_guard();

-- ── 2. Earnings totals for just the affiliates being shown ──
drop function if exists public.admin_affiliate_earnings();

create or replace function public.admin_affiliate_earnings(p_referrer_ids uuid[] default null)
returns table (referrer_id uuid, accruing_usd numeric, awaiting_usd numeric, paid_usd numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  select
    ac.referrer_id,
    coalesce(sum(ac.commission_amount_usd) filter (where ac.status = 'pending' and ac.payout_id is null), 0),
    coalesce(sum(ac.commission_amount_usd) filter (where ac.status = 'pending' and ac.payout_id is not null), 0),
    coalesce(sum(ac.commission_amount_usd) filter (where ac.status = 'paid'), 0)
  from public.affiliate_commissions ac
  where p_referrer_ids is null or ac.referrer_id = any(p_referrer_ids)
  group by ac.referrer_id;
$$;

revoke all on function public.admin_affiliate_earnings(uuid[]) from public, anon, authenticated;
grant execute on function public.admin_affiliate_earnings(uuid[]) to service_role;

insert into public.schema_migrations (filename) values
  ('0067_admin_section8_closeout.sql')
on conflict do nothing;

-- ============================================================
-- 0068_ops_section9_closeout.sql
-- ============================================================
-- ============================================================
-- 0068 — Cron, account deletion & ops: independent audit pass 1
-- ============================================================
-- Idempotent: safe to re-run. Apply BEFORE deploying the code that ships with it.
--
--  * support_reports: admin_note and resolved_by are staff-internal, but the
--    row-level policy "User can view own reports" exposes every COLUMN of the
--    customer's own rows to anyone holding a session token (PostgREST, not just
--    the dashboard page, which happens to select explicit columns). Table-level
--    SELECT is replaced with a column list that leaves the internal ones out. The
--    admin panel and the export read through the service role and are unaffected.
--  * idx_support_reports_user_created: backs the per-account daily cap on
--    /api/support/report (a count of the caller's reports in the last 24h).

revoke select on table public.support_reports from anon, authenticated;
grant select (id, user_id, email, page_url, message, status, created_at, resolved_at)
  on table public.support_reports to authenticated;

create index if not exists idx_support_reports_user_created
  on public.support_reports (user_id, created_at desc);

insert into public.schema_migrations (filename) values
  ('0068_ops_section9_closeout.sql')
on conflict do nothing;

-- ============================================================
-- 0069_api_integrations_pass3.sql
-- ============================================================
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

-- ============================================================
-- 0070_section7_reseller_affiliates_pass4.sql
-- ============================================================
-- 0070_section7_reseller_affiliates_pass4.sql
-- Reseller, affiliates & payouts — independent pass 4.
--
--  * clear_referral_flag(): the back-fill passed the NET order amount to
--    record_affiliate_commission(), which already deducts refunds itself (the
--    BEFORE INSERT refund trigger), so a partly-refunded order lost its refund
--    twice. It now passes the order's gross amount, like every other caller.
--  * claim_pending_reseller_transfers(): an invitation is only claimed while the
--    inviting reseller is still an active account (a suspended reseller's stock
--    stays reserved until the invitation expires or an admin acts).
--  * claim_all_due_pending_transfers(): a sweep for invitations whose address
--    was already a confirmed account when the invitation landed (the confirm /
--    insert triggers only fire at the moment of signup).
--  * create_pending_reseller_transfer(): at most 50 NEW invitations per reseller
--    per rolling 24 h (an invitation is an e-mail to a stranger).
--  * reseller_new_recipients_24h(): the same budget for new registered clients.
--  * Referrer-side SELECT policies on `referrals` and `affiliate_payouts` are
--    dropped: those rows carry fraud signals (flag reason, signup address hash)
--    and payout-destination snapshots, and the dashboard reads them through the
--    service role scoped to the signed-in user instead.
--  * admin_void_commission(): a waived deduction no longer counts as "already
--    recovered", so voiding a paid commission after a waive recovers it again.
--  * admin_void_referral_earnings(): also takes back the standard GB bonus.
--  * my_affiliate_open_deductions(): the true open-deduction total (the list
--    function is capped at 50 rows).
--  * affiliate_payout_reminder_totals(): payout-day reminder totals in SQL
--    (the old code summed at most 20 000 rows fetched through PostgREST's cap).
--  * record_referral_click(): at most 20 NEW tags per code per day.
--  * Webhook events for invitations: reseller_invitation_created / _expired /
--    _cancelled (the claim already fires bandwidth_allocated).
--
-- Idempotent.

-- ── 1. clear_referral_flag: no double refund deduction ──────────────────────
create or replace function public.clear_referral_flag(
  p_referral_id   uuid,
  p_gb            numeric default 1,
  p_min_order_usd numeric default 5
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r              public.referrals%rowtype;
  v_status       text;
  o              record;
  v_res          jsonb;
  v_net          numeric;
  v_count        integer := 0;
  v_total        numeric := 0;
  v_bonus        boolean := false;
begin
  update public.referrals
  set flagged = false, flag_reason = null, flag_confirmed_at = null
  where id = p_referral_id and flagged = true
  returning * into r;
  if not found then
    return null;
  end if;

  select affiliate_status into v_status from public.profiles where id = r.referrer_id;

  for o in
    select id, amount_usd, coalesce(refunded_usd, 0) as refunded_usd, coalesce(paid_at, created_at) as earned_at
    from public.orders
    where user_id = r.referred_user_id
      and bandwidth_credited = true
      and coalesce(is_canary, false) = false
    order by coalesce(paid_at, created_at), created_at
  loop
    v_net := o.amount_usd - o.refunded_usd;
    -- Nothing left of this order to earn on.
    continue when v_net <= 0;

    if v_status = 'approved' then
      -- GROSS amount: record_affiliate_commission() (via its refund trigger)
      -- takes the refunded part off itself. Passing the net amount deducted
      -- the refund twice.
      v_res := public.record_affiliate_commission(r.id, o.id, o.amount_usd, o.earned_at);
      if v_res is not null then
        v_count := v_count + 1;
        v_total := v_total + (v_res->>'commission_usd')::numeric;
      end if;
    elsif v_status is distinct from 'suspended' and not v_bonus then
      if public.credit_referral_bonus(r.id, p_gb, v_net, p_min_order_usd, o.id) then
        v_bonus := true;
      end if;
    end if;
  end loop;

  return jsonb_build_object('commissions_backfilled', v_count, 'commission_usd', v_total, 'bonus_credited', v_bonus);
end;
$$;
revoke all on function public.clear_referral_flag(uuid, numeric, numeric) from public, anon, authenticated;
grant execute on function public.clear_referral_flag(uuid, numeric, numeric) to service_role;

-- ── 2. Referrer-side RLS on fraud / payout-destination rows ─────────────────
drop policy if exists "Referrer can view own referrals" on public.referrals;
drop policy if exists "Referrer can view own payouts" on public.affiliate_payouts;

-- ── 3. Invitations: active reseller only, daily new-invitation budget ───────
create or replace function public.create_pending_reseller_transfer(
  p_reseller_id uuid, p_email text, p_gb numeric, p_note text default null
)
returns table (out_pending_id uuid, out_total_gb numeric, out_expires_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_email   text := lower(trim(coalesce(p_email, '')));
  v_own     text;
  v_updated numeric;
  v_open    integer;
  v_new24   integer;
  v_id      uuid;
  v_total   numeric;
  v_exp     timestamptz;
begin
  if p_gb is null or p_gb < 0.1 then raise exception 'Minimum allocation is 0.1 GB'; end if;
  if p_gb <> round(p_gb, 3) then raise exception 'At most 3 decimal places are allowed'; end if;
  if p_gb > 1000000 then raise exception 'Amount too large'; end if;
  if v_email = '' or v_email not like '%@%' or length(v_email) > 254 then raise exception 'A valid recipient email is required'; end if;

  select email into v_own from public.profiles where id = p_reseller_id;
  if v_own is not null and public.normalize_email_alias(v_own) = public.normalize_email_alias(v_email) then
    raise exception 'Cannot allocate bandwidth to yourself';
  end if;

  perform 1 from public.bandwidth_accounts where user_id = p_reseller_id for update;

  select count(*) into v_open from public.reseller_pending_transfers
  where reseller_id = p_reseller_id and status = 'pending';
  if v_open >= 100 and not exists (
    select 1 from public.reseller_pending_transfers where reseller_id = p_reseller_id and recipient_email = v_email and status = 'pending'
  ) then
    raise exception 'Too many open invitations — cancel some or wait for them to be claimed.';
  end if;

  -- An invitation is an e-mail to someone who never asked for it: bound how many
  -- NEW addresses one reseller can invite per day (topping up an open invitation
  -- is not new).
  if not exists (
    select 1 from public.reseller_pending_transfers where reseller_id = p_reseller_id and recipient_email = v_email and status = 'pending'
  ) then
    select count(*) into v_new24 from public.reseller_pending_transfers
    where reseller_id = p_reseller_id and created_at > now() - interval '24 hours';
    if v_new24 >= 50 then
      raise exception 'Too many new recipients today — try again tomorrow.';
    end if;
  end if;

  update public.bandwidth_accounts
  set allocated_gb = allocated_gb + p_gb
  where user_id = p_reseller_id and (total_gb - allocated_gb) >= p_gb
  returning allocated_gb into v_updated;
  if v_updated is null then
    raise exception 'Not enough bandwidth in your stock.' using errcode = 'P0001';
  end if;

  insert into public.reseller_pending_transfers (reseller_id, recipient_email, gb_amount, note)
  values (p_reseller_id, v_email, p_gb, nullif(left(trim(coalesce(p_note, '')), 200), ''))
  on conflict (reseller_id, recipient_email) where status = 'pending'
  do update set gb_amount = public.reseller_pending_transfers.gb_amount + excluded.gb_amount,
                note = coalesce(excluded.note, public.reseller_pending_transfers.note),
                expires_at = now() + interval '30 days'
  returning id, gb_amount, expires_at into v_id, v_total, v_exp;

  return query select v_id, v_total, v_exp;
end;
$$;
revoke all on function public.create_pending_reseller_transfer(uuid, text, numeric, text) from public, anon, authenticated;
grant execute on function public.create_pending_reseller_transfer(uuid, text, numeric, text) to service_role;

-- New registered clients + new invitations a reseller opened in the last 24 h
-- (a client counts as new when this reseller never sent to them before the
-- window). The allocate path refuses a NEW recipient beyond 50.
create or replace function public.reseller_new_recipients_24h(p_reseller_id uuid)
returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select (
    select count(*) from (
      select recipient_id from public.reseller_transfers
      where reseller_id = p_reseller_id and recipient_id is not null
      group by recipient_id
      having min(created_at) > now() - interval '24 hours'
    ) x
  )::integer + (
    select count(*) from public.reseller_pending_transfers
    where reseller_id = p_reseller_id and created_at > now() - interval '24 hours'
  )::integer;
$$;
revoke all on function public.reseller_new_recipients_24h(uuid) from public, anon, authenticated;
grant execute on function public.reseller_new_recipients_24h(uuid) to service_role;

create or replace function public.claim_pending_reseller_transfers(p_user_id uuid)
returns table (out_transfer_id uuid, out_reseller_id uuid, out_gb numeric)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_email text;
  v_ok    boolean;
  p       record;
  v_tid   uuid;
begin
  select lower(pr.email), (u.email_confirmed_at is not null)
         and not coalesce(pr.is_deleted, false) and not coalesce(pr.is_suspended, false)
    into v_email, v_ok
  from public.profiles pr join auth.users u on u.id = pr.id
  where pr.id = p_user_id;
  if v_email is null or not coalesce(v_ok, false) then return; end if;

  for p in
    select t.* from public.reseller_pending_transfers t
    where t.recipient_email = v_email and t.status = 'pending' and t.expires_at > now() and t.reseller_id <> p_user_id
      -- The inviting reseller must still be an active account; otherwise the
      -- invitation waits (and expires, returning the stock) rather than moving
      -- bandwidth on behalf of a suspended or closed reseller.
      and exists (select 1 from public.profiles rs
                  where rs.id = t.reseller_id and not coalesce(rs.is_deleted, false) and not coalesce(rs.is_suspended, false))
    order by t.created_at for update of t
  loop
    perform 1 from public.bandwidth_accounts where user_id = p_user_id for update;
    insert into public.bandwidth_accounts (user_id, total_gb, used_gb, allocated_gb)
    values (p_user_id, p.gb_amount, 0, 0)
    on conflict (user_id) do update set total_gb = public.bandwidth_accounts.total_gb + excluded.total_gb;

    insert into public.reseller_transfers (reseller_id, recipient_id, gb_amount, status, activated_at, note)
    values (p.reseller_id, p_user_id, p.gb_amount, 'active', now(), p.note)
    returning id into v_tid;

    update public.reseller_pending_transfers
    set status = 'claimed', resolved_at = now(), claimed_by = p_user_id, transfer_id = v_tid
    where id = p.id;

    out_transfer_id := v_tid; out_reseller_id := p.reseller_id; out_gb := p.gb_amount;
    return next;
  end loop;
end;
$$;
revoke all on function public.claim_pending_reseller_transfers(uuid) from public, anon, authenticated;
grant execute on function public.claim_pending_reseller_transfers(uuid) to service_role;

-- Sweep (hourly): any open invitation whose address already belongs to a
-- confirmed, active account is claimed now. Bounded per run.
create or replace function public.claim_all_due_pending_transfers()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid;
  v_n   integer := 0;
  v_c   integer;
begin
  for v_uid in
    select distinct pr.id
    from public.reseller_pending_transfers t
    join public.profiles pr on lower(pr.email) = t.recipient_email
    join auth.users u on u.id = pr.id
    where t.status = 'pending' and t.expires_at > now()
      and u.email_confirmed_at is not null
      and not coalesce(pr.is_deleted, false) and not coalesce(pr.is_suspended, false)
    limit 200
  loop
    select count(*) into v_c from public.claim_pending_reseller_transfers(v_uid);
    v_n := v_n + v_c;
  end loop;
  return v_n;
end;
$$;
revoke all on function public.claim_all_due_pending_transfers() from public, anon, authenticated;
grant execute on function public.claim_all_due_pending_transfers() to service_role;

-- ── 4. Void: waived deductions are not "recovered"; also reverse the GB bonus ─
create or replace function public.admin_void_commission(p_commission_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.affiliate_commissions%rowtype;
  v_reason text := nullif(left(trim(coalesce(p_reason, '')), 300), '');
  v_payout_amt numeric;
  v_have numeric;
  v_owe numeric;
  v_deleted boolean;
begin
  select * into c from public.affiliate_commissions where id = p_commission_id for update;
  if not found or c.status = 'void' or c.voided_at is not null then
    return null;
  end if;

  if c.status = 'pending' then
    update public.affiliate_commissions
    set status = 'void', voided_at = now(), void_reason = v_reason
    where id = c.id;
    if c.payout_id is not null then
      update public.affiliate_payouts
      set amount_usd = greatest(amount_usd - c.commission_amount_usd, 0)
      where id = c.payout_id and status = 'pending'
      returning amount_usd into v_payout_amt;
      if found and v_payout_amt <= 0 then
        delete from public.affiliate_payouts where id = c.payout_id;
      end if;
    end if;
    return jsonb_build_object('action', case when c.payout_id is null then 'voided' else 'voided_from_payout' end,
                              'referrer_id', c.referrer_id, 'amount_usd', c.commission_amount_usd);
  end if;

  -- Paid: the money is gone; recover what hasn't already been clawed back. A
  -- WAIVED deduction was forgiven, not recovered, so it does not count.
  select coalesce(-sum(amount_usd), 0) into v_have from public.affiliate_adjustments
  where commission_id = c.id and waived_at is null;
  v_owe := round(c.commission_amount_usd - v_have, 2);
  select coalesce(is_deleted, false) into v_deleted from public.profiles where id = c.referrer_id;
  update public.affiliate_commissions set voided_at = now(), void_reason = v_reason where id = c.id;
  if v_owe > 0 and not coalesce(v_deleted, false) then
    insert into public.affiliate_adjustments (referrer_id, commission_id, order_id, amount_usd, reason)
    values (c.referrer_id, c.id, c.order_id, -v_owe, 'admin_void_paid');
  end if;
  return jsonb_build_object('action', 'clawback_recorded', 'referrer_id', c.referrer_id, 'amount_usd', greatest(v_owe, 0));
end;
$$;
revoke all on function public.admin_void_commission(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_void_commission(uuid, text) to service_role;

create or replace function public.admin_void_referral_earnings(p_referral_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  rf public.referrals%rowtype;
  cid uuid;
  res jsonb;
  v_voided integer := 0;
  v_clawed integer := 0;
  v_usd numeric := 0;
  v_avail numeric;
  v_claw_a numeric := 0;
  v_claw_b numeric := 0;
begin
  select * into rf from public.referrals where id = p_referral_id for update;
  if not found then
    return null;
  end if;

  update public.referrals
  set flagged = true,
      flag_reason = coalesce(flag_reason, 'admin_flagged'),
      flag_confirmed_at = coalesce(flag_confirmed_at, now())
  where id = rf.id;

  for cid in select id from public.affiliate_commissions where referral_id = rf.id and status <> 'void' and voided_at is null loop
    res := public.admin_void_commission(cid, p_reason);
    if res is not null then
      v_usd := v_usd + coalesce((res ->> 'amount_usd')::numeric, 0);
      if res ->> 'action' = 'clawback_recorded' then v_clawed := v_clawed + 1; else v_voided := v_voided + 1; end if;
    end if;
  end loop;

  -- The standard GB bonus (non-affiliate referrer) is earnings too: take back
  -- what is still unspent, from both sides, exactly like a refund does.
  if rf.gb_bonus_credited_at is not null and rf.gb_bonus_reversed_at is null and coalesce(rf.gb_bonus_amount, 0) > 0 then
    perform 1 from public.bandwidth_accounts
    where user_id in (rf.referrer_id, rf.referred_user_id) order by user_id for update;

    select greatest(coalesce(available_gb, 0), 0) into v_avail from public.bandwidth_accounts where user_id = rf.referrer_id;
    v_claw_a := least(rf.gb_bonus_amount, coalesce(v_avail, 0));
    if v_claw_a > 0 then
      update public.bandwidth_accounts set total_gb = total_gb - v_claw_a where user_id = rf.referrer_id;
    end if;

    select greatest(coalesce(available_gb, 0), 0) into v_avail from public.bandwidth_accounts where user_id = rf.referred_user_id;
    v_claw_b := least(rf.gb_bonus_amount, coalesce(v_avail, 0));
    if v_claw_b > 0 then
      update public.bandwidth_accounts set total_gb = total_gb - v_claw_b where user_id = rf.referred_user_id;
    end if;

    update public.referrals set gb_bonus_reversed_at = now() where id = rf.id;
    insert into public.admin_audit_log (admin_id, action, target_user_id, target_ref, details)
    values (null, 'referral_bonus_reversed', rf.referrer_id, rf.id::text,
            jsonb_build_object('referral_id', rf.id, 'bonus_gb', rf.gb_bonus_amount, 'via', 'admin_void',
                               'clawed_from_referrer_gb', v_claw_a, 'clawed_from_referred_gb', v_claw_b));
  end if;

  return jsonb_build_object('referrer_id', rf.referrer_id, 'voided', v_voided, 'clawbacks', v_clawed, 'amount_usd', v_usd,
                            'bonus_clawed_referrer_gb', v_claw_a, 'bonus_clawed_referred_gb', v_claw_b);
end;
$$;
revoke all on function public.admin_void_referral_earnings(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_void_referral_earnings(uuid, text) to service_role;

-- ── 5. Open deductions (uncapped) and payout-day reminder totals ────────────
create or replace function public.my_affiliate_open_deductions(p_user_id uuid)
returns numeric language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(-sum(amount_usd), 0)
  from public.affiliate_adjustments
  where referrer_id = p_user_id and payout_id is null and waived_at is null;
$$;
revoke all on function public.my_affiliate_open_deductions(uuid) from public, anon, authenticated;
grant execute on function public.my_affiliate_open_deductions(uuid) to service_role;

create or replace function public.affiliate_payout_reminder_totals(p_cycle_end date)
returns table (out_affiliates bigint, out_total_usd numeric, out_deductions_usd numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  select
    (select count(distinct referrer_id) from public.affiliate_commissions
      where payout_id is null and status = 'pending' and created_at < (p_cycle_end + 1)::timestamptz),
    (select coalesce(sum(commission_amount_usd), 0) from public.affiliate_commissions
      where payout_id is null and status = 'pending' and created_at < (p_cycle_end + 1)::timestamptz),
    (select coalesce(-sum(amount_usd), 0) from public.affiliate_adjustments
      where payout_id is null and waived_at is null);
$$;
revoke all on function public.affiliate_payout_reminder_totals(date) from public, anon, authenticated;
grant execute on function public.affiliate_payout_reminder_totals(date) to service_role;

-- ── 6. Per-day cap on NEW referral tags ─────────────────────────────────────
drop function if exists public.record_referral_click(text, text);
create or replace function public.record_referral_click(p_code text, p_sub_id text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id  uuid;
  v_sub text := nullif(left(regexp_replace(coalesce(p_sub_id, ''), '[^A-Za-z0-9_-]', '', 'g'), 32), '');
  v_day date := (now() at time zone 'UTC')::date;
begin
  select id into v_id from public.profiles
  where referral_code = upper(trim(coalesce(p_code, ''))) and not coalesce(is_deleted, false);
  if v_id is null then return; end if;

  insert into public.referral_clicks (referrer_id, day, clicks)
  values (v_id, v_day, 1)
  on conflict (referrer_id, day) do update set clicks = public.referral_clicks.clicks + 1;

  if v_sub is not null then
    -- The tag is free text in a public link. Bound the distinct tags one code
    -- can hold (100) AND how many NEW ones it can gain per day (20), so the
    -- cap cannot be filled in one burst by anyone who knows the code.
    if exists (select 1 from public.referral_tag_clicks where referrer_id = v_id and sub_id = v_sub)
       or (
         (select count(distinct sub_id) from public.referral_tag_clicks where referrer_id = v_id) < 100
         and (select count(*) from (
                select sub_id from public.referral_tag_clicks where referrer_id = v_id
                group by sub_id having min(day) = v_day) n) < 20
       ) then
      insert into public.referral_tag_clicks (referrer_id, sub_id, day, clicks)
      values (v_id, v_sub, v_day, 1)
      on conflict (referrer_id, sub_id, day) do update set clicks = public.referral_tag_clicks.clicks + 1;
    end if;
  end if;
end;
$$;
revoke all on function public.record_referral_click(text, text) from public, anon, authenticated;
grant execute on function public.record_referral_click(text, text) to service_role;

-- ── 7. Invitation webhook events ────────────────────────────────────────────
-- COMPLETE list as of 0069 plus the three invitation events.
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
    'reseller_invitation_created', 'reseller_invitation_expired', 'reseller_invitation_cancelled',
    'api_key_created', 'api_key_revoked', 'api_key_expiring'
  ]::text[]);

insert into public.schema_migrations (filename) values
  ('0070_section7_reseller_affiliates_pass4.sql')
on conflict do nothing;

-- ============================================================
-- 0071_auth_mfa_pass5.sql
-- ============================================================
-- ─────────────────────────────────────────────────────────────────────
-- 0071 · Auth & MFA — independent pass 5
--
--  1. mfa_verified_sessions.auth_session_id: the GoTrue login session
--     (auth.sessions.id = the JWT session_id claim) a verified / trusted
--     browser is currently signed in under. Lets "sign this device out" in
--     Settings end that browser's 2FA trust too; before, a browser holding a
--     30-day trusted cookie skipped the code on its next password sign-in even
--     after the owner had signed the device out.
--     Nullable on purpose: rows created before this migration simply have no
--     link (they keep working and expire on their own), and a browser that
--     signs in again re-links itself. Deliberately NOT a foreign key / cascade:
--     a normal sign-out deletes the auth.sessions row, and "trust this browser"
--     is meant to survive that.
-- Idempotent. Apply BEFORE / WITH the deploy (the app falls back to the old
-- row shape and logs a loud error until it exists).
-- ─────────────────────────────────────────────────────────────────────

alter table public.mfa_verified_sessions
  add column if not exists auth_session_id uuid;

create index if not exists mfa_verified_sessions_auth_session_idx
  on public.mfa_verified_sessions (user_id, auth_session_id)
  where auth_session_id is not null;

insert into public.schema_migrations (filename) values
  ('0071_auth_mfa_pass5.sql')
on conflict do nothing;

-- ============================================================
-- 0072_section7_reseller_affiliates_pass5.sql (folded)
-- ============================================================
-- 0072_section7_reseller_affiliates_pass5.sql
-- Reseller, affiliates & payouts — independent pass 5.
--
--  * reclaim_reseller_allocation(): admin bandwidth credits made after the
--    transfer now count as "later" bandwidth, like top-ups and referral bonuses,
--    so a reclaim can no longer sweep an admin goodwill credit back to the reseller.
--  * reseller_client_roster(): optional filter (unused / exhausted / idle) and
--    sort (recent / sent / used / remaining / name), and a stable order — rows
--    with equal timestamps were free to repeat or vanish across pages. The old
--    4-argument signature is dropped; the new one keeps defaults, so callers
--    passing four arguments keep working.
--  * Payout hold reason: profiles.payout_hold_reason says WHY the 48 h hold is
--    running (the payout method changed vs. an account-security event), so the
--    dashboard no longer tells someone "your payout details changed" after they
--    merely changed their password.
--  * Invitation reminders: reseller_pending_transfers.last_reminded_at /
--    reminder_count and remind_pending_reseller_transfer() — an atomic
--    "may this invitation be re-sent now?" (24 h apart, at most 3 reminders).
--
-- Idempotent.

-- ── 1. Reclaim counts admin credits as later bandwidth ──────────────────────
create or replace function public.reclaim_reseller_allocation(
  p_transfer_id uuid,
  p_reseller_id uuid,
  p_gb          numeric default null
)
returns table (out_reclaimed_gb numeric, out_remaining_gb numeric)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c_window constant interval := interval '30 days';
  t public.reseller_transfers%rowtype;
  v_remaining numeric;
  v_avail numeric;
  v_later numeric;
  v_amount numeric;
begin
  select * into t from public.reseller_transfers
  where id = p_transfer_id and reseller_id = p_reseller_id for update;
  if not found then
    raise exception 'Transfer not found';
  end if;
  if t.status <> 'active' then
    raise exception 'Nothing left to reclaim on this transfer';
  end if;
  if t.created_at < now() - c_window then
    raise exception 'Nothing left to reclaim — the 30-day reclaim window for this transfer has closed.';
  end if;

  perform 1 from public.bandwidth_accounts
  where user_id in (t.reseller_id, t.recipient_id) order by user_id for update;

  v_remaining := t.gb_amount - t.reclaimed_gb;
  select greatest(coalesce(available_gb, 0), 0) into v_avail
  from public.bandwidth_accounts where user_id = t.recipient_id;
  v_avail := coalesce(v_avail, 0);

  v_later :=
    coalesce((
      select sum(o.gb_amount * (1 - least(coalesce(o.refunded_usd, 0) / nullif(o.amount_usd, 0), 1)))
      from public.orders o
      where o.user_id = t.recipient_id and o.bandwidth_credited = true
        and coalesce(o.is_canary, false) = false and o.paid_at > t.created_at
    ), 0)
    + coalesce((
      select sum(x.gb_amount - x.reclaimed_gb)
      from public.reseller_transfers x
      where x.recipient_id = t.recipient_id and x.id <> t.id and x.created_at > t.created_at
    ), 0)
    + coalesce((
      -- Admin credits since the transfer are ALSO "later" bandwidth: an admin top-up
      -- (goodwill credit, manual fix) must not be swept back to the reseller by a
      -- reclaim that only knew about orders, transfers and referral bonuses.
      -- Net of admin deductions and never below zero: a deduction already lowered
      -- the client's available figure, it must not shrink the protected amount twice.
      select greatest(sum(ba.gb_delta), 0)
      from public.bandwidth_adjustments ba
      where ba.user_id = t.recipient_id and ba.created_at > t.created_at
    ), 0)
    + coalesce((
      select sum(rf.gb_bonus_amount)
      from public.referrals rf
      where (rf.referrer_id = t.recipient_id or rf.referred_user_id = t.recipient_id)
        and rf.gb_bonus_credited_at > t.created_at and rf.gb_bonus_reversed_at is null
    ), 0);

  v_amount := least(v_remaining, greatest(v_avail - v_later, 0));
  if p_gb is not null then
    v_amount := least(v_amount, p_gb);
  end if;
  v_amount := round(v_amount, 3);

  if v_amount <= 0 then
    raise exception 'Nothing to reclaim — the client has already used, assigned or topped up past this bandwidth.';
  end if;

  update public.bandwidth_accounts set total_gb = total_gb - v_amount where user_id = t.recipient_id;
  update public.bandwidth_accounts set allocated_gb = greatest(allocated_gb - v_amount, 0) where user_id = t.reseller_id;

  update public.reseller_transfers
  set reclaimed_gb = reclaimed_gb + v_amount,
      status = case when reclaimed_gb + v_amount >= gb_amount then 'reclaimed' else status end
  where id = t.id;

  return query select v_amount, v_remaining - v_amount;
end;
$$;

revoke all on function public.reclaim_reseller_allocation(uuid, uuid, numeric) from public, anon, authenticated;
grant execute on function public.reclaim_reseller_allocation(uuid, uuid, numeric) to service_role;

-- ── 2. Roster: filter, sort, stable order ───────────────────────────────────
drop function if exists public.reseller_client_roster(uuid, text, integer, integer);

create or replace function public.reseller_client_roster(
  p_reseller_id uuid,
  p_search      text default null,
  p_limit       integer default 25,
  p_offset      integer default 0,
  p_filter      text default 'all',   -- all | unused | exhausted | idle
  p_sort        text default 'recent' -- recent | sent | used | remaining | name
)
returns table (
  client_id           uuid,
  email               text,
  full_name           text,
  is_deleted          boolean,
  is_suspended        boolean,
  transfer_count      bigint,
  total_received_gb   numeric,
  total_reclaimed_gb  numeric,
  last_transfer_at    timestamptz,
  last_note           text,
  client_total_gb     numeric,
  client_used_gb      numeric,
  client_available_gb numeric,
  total_count         bigint
) language sql stable security definer set search_path = public, pg_temp as $$
  with agg as (
    select rt.recipient_id,
           count(*) as cnt,
           sum(rt.gb_amount) as recv,
           sum(rt.reclaimed_gb) as recl,
           max(rt.created_at) as last_at,
           (array_agg(rt.note order by rt.created_at desc) filter (where rt.note is not null))[1] as last_note
    from public.reseller_transfers rt
    where rt.reseller_id = p_reseller_id
    group by rt.recipient_id
  ),
  r as (
    select a.recipient_id, p.email, p.full_name,
           coalesce(p.is_deleted, false) as is_deleted, coalesce(p.is_suspended, false) as is_suspended,
           a.cnt, a.recv, a.recl, a.last_at, a.last_note,
           -- Scoped to what THIS reseller sent (net of reclaims): the client's
           -- other purchases / other resellers' transfers are not this
           -- reseller's business.
           (a.recv - a.recl) as net,
           least(coalesce(b.used_gb, 0), a.recv - a.recl) as used,
           least(greatest(coalesce(b.available_gb, 0), 0),
                 greatest((a.recv - a.recl) - least(coalesce(b.used_gb, 0), a.recv - a.recl), 0)) as avail
    from agg a
    join public.profiles p on p.id = a.recipient_id
    left join public.bandwidth_accounts b on b.user_id = a.recipient_id
    where p_search is null or p_search = ''
       or p.email ilike '%' || replace(replace(p_search, '%', '\%'), '_', '\_') || '%'
       or p.full_name ilike '%' || replace(replace(p_search, '%', '\%'), '_', '\_') || '%'
  )
  select r.recipient_id, r.email, r.full_name, r.is_deleted, r.is_suspended,
         r.cnt, r.recv, r.recl, r.last_at, r.last_note,
         r.net, r.used, r.avail,
         count(*) over ()
  from r
  where case coalesce(p_filter, 'all')
          when 'unused'    then r.net > 0 and r.used <= 0.0005 and not r.is_deleted
          when 'exhausted' then r.net > 0 and r.used >= r.net - 0.0005 and not r.is_deleted
          when 'idle'      then r.last_at < now() - interval '30 days'
          else true
        end
  order by
    case when p_sort = 'sent'      then r.net end desc nulls last,
    case when p_sort = 'used'      then r.used end desc nulls last,
    case when p_sort = 'remaining' then (r.net - r.used) end asc nulls last,
    case when p_sort = 'name'      then lower(r.email) end asc nulls last,
    r.last_at desc, r.recipient_id
  limit least(greatest(p_limit, 1), 100) offset greatest(p_offset, 0);
$$;
revoke all on function public.reseller_client_roster(uuid, text, integer, integer, text, text) from public, anon, authenticated;
grant execute on function public.reseller_client_roster(uuid, text, integer, integer, text, text) to service_role;

-- ── 3. Why is the payout hold running? ──────────────────────────────────────
alter table public.profiles add column if not exists payout_hold_reason text;
alter table public.profiles drop constraint if exists profiles_payout_hold_reason_check;
alter table public.profiles add constraint profiles_payout_hold_reason_check
  check (payout_hold_reason is null or payout_hold_reason in ('method_changed', 'security_event'));

-- A user must not be able to relabel their own hold (same rule as
-- payout_method_updated_at in protect_privileged_profile_columns).
create or replace function public.protect_payout_hold_reason()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return new; -- service-role client
  end if;
  if public.is_admin(auth.uid()) then
    return new;
  end if;
  new.payout_hold_reason := old.payout_hold_reason;
  return new;
end;
$$;
revoke all on function public.protect_payout_hold_reason() from public, anon, authenticated;

drop trigger if exists trg_protect_payout_hold_reason on public.profiles;
create trigger trg_protect_payout_hold_reason
  before update on public.profiles
  for each row execute function public.protect_payout_hold_reason();

create or replace function public.bump_payout_hold_on_security_event()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.event in ('password_changed', 'email_change_requested', 'mfa_disabled',
                   'mfa_reset_by_admin', 'mfa_backup_regenerated',
                   'email_changed', 'mfa_recovery_completed') then
    update public.profiles
    set payout_method_updated_at = now(),
        payout_hold_reason = 'security_event'
    where id = new.user_id and payout_method is not null;
  end if;
  return new;
end;
$$;
revoke all on function public.bump_payout_hold_on_security_event() from public, anon, authenticated;

create or replace function public.sync_profile_email()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.email is distinct from old.email then
    update public.profiles
    set email = new.email,
        updated_at = now(),
        payout_method_updated_at = case when payout_method is not null then now() else payout_method_updated_at end,
        payout_hold_reason = case when payout_method is not null then 'security_event' else payout_hold_reason end
    where id = new.id;
  end if;
  return new;
end;
$$;

-- ── 4. Invitation reminders ─────────────────────────────────────────────────
alter table public.reseller_pending_transfers add column if not exists last_reminded_at timestamptz;
alter table public.reseller_pending_transfers add column if not exists reminder_count integer not null default 0;

-- Atomic "may this invitation be re-sent now?". The e-mail itself is sent by
-- the caller; this stamps the reminder under the row lock so two clicks (or a
-- click and an API call) can never both pass. A reminder can go out at most
-- p_cooldown_hours after the invitation was sent or last reminded, and at most
-- p_max times in total.
create or replace function public.remind_pending_reseller_transfer(
  p_id uuid, p_reseller_id uuid, p_cooldown_hours integer default 24, p_max integer default 3
)
returns table (out_result text, out_email text, out_gb numeric, out_expires_at timestamptz, out_retry_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p public.reseller_pending_transfers%rowtype;
  v_next timestamptz;
begin
  select * into p from public.reseller_pending_transfers
  where id = p_id and reseller_id = p_reseller_id and status = 'pending' for update;
  if not found or p.expires_at <= now() then
    return query select 'not_found'::text, null::text, null::numeric, null::timestamptz, null::timestamptz;
    return;
  end if;
  if p.reminder_count >= p_max then
    return query select 'limit'::text, p.recipient_email, p.gb_amount, p.expires_at, null::timestamptz;
    return;
  end if;
  v_next := coalesce(p.last_reminded_at, p.created_at) + make_interval(hours => p_cooldown_hours);
  if v_next > now() then
    return query select 'cooldown'::text, p.recipient_email, p.gb_amount, p.expires_at, v_next;
    return;
  end if;
  update public.reseller_pending_transfers
  set last_reminded_at = now(), reminder_count = reminder_count + 1
  where id = p.id;
  return query select 'ok'::text, p.recipient_email, p.gb_amount, p.expires_at, null::timestamptz;
end;
$$;
revoke all on function public.remind_pending_reseller_transfer(uuid, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.remind_pending_reseller_transfer(uuid, uuid, integer, integer) to service_role;

insert into public.schema_migrations (filename) values
  ('0072_section7_reseller_affiliates_pass5.sql')
on conflict do nothing;

-- ============================================================
-- 0073_admin_section8_pass5.sql (folded)
-- ============================================================
-- 0073_admin_section8_pass5.sql
-- Admin & Verified Operators — independent pass 5.
--
--  1. admin_locks + claim_admin_lock()/release_admin_lock(): an atomic lock so
--     two full usage syncs can never overlap (the old guard read the audit log,
--     which is only written when a sync FINISHES).
--  2. Ban matching: normalize_ban_email() now also folds Gmail's dot-insensitivity
--     and googlemail.com (a.b@gmail.com = ab@gmail.com), is_email_banned() also
--     honours "@domain" entries, and profiles_matching_ban() finds the existing
--     accounts a ban affects, alias-aware.
--  3. admin_audit_log stays append-only, but a narrow SECURITY DEFINER path
--     (redact_admin_audit_details) may REMOVE named keys from details — so
--     personal data that should never have been logged can be erased. The emails
--     already written by user.delete / reseller_invitation_cancelled are scrubbed.
--  4. support_report_replies: what support wrote back to a customer.
--  5. affiliate_rate_history: the rates in force at each moment, so a commission
--     back-filled later (clear_referral_flag) is paid at the rate that applied
--     WHEN the order was paid, not today's. record_affiliate_commission() uses it.
--  6. verified_operator_reviews + admin_affiliate_performance(): periodic review
--     of Verified Operators and the numbers to decide a grant or a review on.
--  7. admin_reverse_paid_payout(): a payout marked paid whose money never arrived
--     goes back to pending.
--
-- Safe to run against the live DB: idempotent.

-- ── 1. Admin locks ─────────────────────────────────────────
create table if not exists public.admin_locks (
  key          text primary key,
  locked_until timestamptz not null
);
alter table public.admin_locks enable row level security;
revoke all on table public.admin_locks from anon, authenticated;

create or replace function public.claim_admin_lock(p_key text, p_ttl_seconds integer)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_got boolean;
begin
  insert into public.admin_locks (key, locked_until)
  values (p_key, now() + make_interval(secs => greatest(p_ttl_seconds, 1)))
  on conflict (key) do update
    set locked_until = excluded.locked_until
    where public.admin_locks.locked_until <= now()
  returning true into v_got;
  return coalesce(v_got, false);
end;
$$;

create or replace function public.release_admin_lock(p_key text, p_cooldown_seconds integer default 0)
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.admin_locks
     set locked_until = now() + make_interval(secs => greatest(p_cooldown_seconds, 0))
   where key = p_key;
$$;

revoke all on function public.claim_admin_lock(text, integer) from public, anon, authenticated;
revoke all on function public.release_admin_lock(text, integer) from public, anon, authenticated;
grant execute on function public.claim_admin_lock(text, integer) to service_role;
grant execute on function public.release_admin_lock(text, integer) to service_role;

-- ── 2. Ban matching ────────────────────────────────────────
create or replace function public.normalize_ban_email(p text)
returns text language sql immutable as $$
  select case
    when lower(split_part(trim(p), '@', 2)) in ('gmail.com', 'googlemail.com')
      then replace(regexp_replace(lower(split_part(trim(p), '@', 1)), '\+.*$', ''), '.', '') || '@gmail.com'
    else regexp_replace(lower(split_part(trim(p), '@', 1)), '\+.*$', '') || '@' || lower(split_part(trim(p), '@', 2))
  end;
$$;

-- The expression index was built with the old definition.
reindex index public.banned_emails_normalized_idx;

create or replace function public.is_email_banned(check_email text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.banned_emails b
    where public.normalize_ban_email(b.email) = public.normalize_ban_email(check_email)
       or (left(b.email, 1) = '@' and lower(b.email) = '@' || lower(split_part(trim(check_email), '@', 2)))
  );
$$;

create or replace function public.profiles_matching_ban(p_email text)
returns table (id uuid, email text, full_name text, role text, is_suspended boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select p.id, p.email, p.full_name, p.role, coalesce(p.is_suspended, false)
  from public.profiles p
  where coalesce(p.is_deleted, false) = false
    and p.email is not null and p.email <> '[deleted]'
    and case
          when left(trim(p_email), 1) = '@'
            then lower(split_part(p.email, '@', 2)) = lower(substr(trim(p_email), 2))
          else public.normalize_ban_email(p.email) = public.normalize_ban_email(p_email)
        end
  order by p.created_at
  limit 200;
$$;

revoke all on function public.profiles_matching_ban(text) from public, anon, authenticated;
grant execute on function public.profiles_matching_ban(text) to service_role;
revoke all on function public.is_email_banned(text) from public, anon, authenticated;
grant execute on function public.is_email_banned(text) to service_role;
revoke all on function public.normalize_ban_email(text) from public, anon, authenticated;
grant execute on function public.normalize_ban_email(text) to service_role;

-- ── 3. Audit log: append-only, with a narrow redaction path ─
create or replace function public.admin_audit_log_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE'
     and new.id         is not distinct from old.id
     and new.action     is not distinct from old.action
     and new.target_ref is not distinct from old.target_ref
     and new.details    is not distinct from old.details
     and new.created_at is not distinct from old.created_at
     and (new.admin_id        is not distinct from old.admin_id        or new.admin_id        is null)
     and (new.target_user_id  is not distinct from old.target_user_id  or new.target_user_id  is null)
  then
    return new;
  end if;
  -- Redaction: ONLY removing keys from details, ONLY via redact_admin_audit_details().
  if tg_op = 'UPDATE'
     and coalesce(current_setting('app.admin_audit_redaction', true), '') = 'on'
     and new.id         is not distinct from old.id
     and new.action     is not distinct from old.action
     and new.target_ref is not distinct from old.target_ref
     and new.created_at is not distinct from old.created_at
     and new.admin_id        is not distinct from old.admin_id
     and new.target_user_id  is not distinct from old.target_user_id
     and old.details @> new.details
  then
    return new;
  end if;
  raise exception 'admin_audit_log is append-only (% refused)', tg_op using errcode = '42501';
end;
$$;

create or replace function public.redact_admin_audit_details(
  p_action text, p_keys text[], p_target_user uuid default null
)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n integer;
begin
  perform set_config('app.admin_audit_redaction', 'on', true);
  update public.admin_audit_log
     set details = details - p_keys
   where action = p_action
     and (p_target_user is null or target_user_id = p_target_user)
     and details ?| p_keys;
  get diagnostics v_n = row_count;
  perform set_config('app.admin_audit_redaction', 'off', true);
  return v_n;
end;
$$;
revoke all on function public.redact_admin_audit_details(text, text[], uuid) from public, anon, authenticated;
grant execute on function public.redact_admin_audit_details(text, text[], uuid) to service_role;

-- One-off: personal data that earlier versions wrote into the log.
select public.redact_admin_audit_details('user.delete', array['email']);
select public.redact_admin_audit_details('reseller_invitation_cancelled', array['recipient_email']);

-- ── 4. What support told the customer ──────────────────────
create table if not exists public.support_report_replies (
  id         uuid default uuid_generate_v4() primary key,
  report_id  uuid not null references public.support_reports(id) on delete cascade,
  admin_id   uuid references public.profiles(id) on delete set null,
  message    text not null check (char_length(message) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists idx_support_report_replies_report on public.support_report_replies(report_id, created_at);
alter table public.support_report_replies enable row level security;
revoke all on table public.support_report_replies from anon, authenticated;

-- ── 5. Affiliate rate history ──────────────────────────────
create table if not exists public.affiliate_rate_history (
  id             uuid default uuid_generate_v4() primary key,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  intro_rate     numeric not null,
  lifetime_rate  numeric not null,
  effective_from timestamptz not null default now(),
  source         text
);
create index if not exists idx_affiliate_rate_history_user on public.affiliate_rate_history(user_id, effective_from desc);
alter table public.affiliate_rate_history enable row level security;
revoke all on table public.affiliate_rate_history from anon, authenticated;

insert into public.affiliate_rate_history (user_id, intro_rate, lifetime_rate, effective_from, source)
select p.id, coalesce(p.affiliate_commission_rate, 0.30), coalesce(p.affiliate_commission_rate_lifetime, 0.15), 'epoch', 'seed'
from public.profiles p
where p.affiliate_status in ('approved', 'suspended')
  and not exists (select 1 from public.affiliate_rate_history h where h.user_id = p.id);

create or replace function public.record_affiliate_rate_change()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.affiliate_commission_rate is null and new.affiliate_commission_rate_lifetime is null then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.affiliate_commission_rate          is not distinct from old.affiliate_commission_rate
     and new.affiliate_commission_rate_lifetime is not distinct from old.affiliate_commission_rate_lifetime then
    return new;
  end if;
  insert into public.affiliate_rate_history (user_id, intro_rate, lifetime_rate, source)
  values (new.id, coalesce(new.affiliate_commission_rate, 0.30), coalesce(new.affiliate_commission_rate_lifetime, 0.15), tg_op);
  return new;
end;
$$;

drop trigger if exists trg_record_affiliate_rate_change on public.profiles;
create trigger trg_record_affiliate_rate_change
  after insert or update of affiliate_commission_rate, affiliate_commission_rate_lifetime on public.profiles
  for each row execute function public.record_affiliate_rate_change();

-- The rate level now comes from the history row in force at the earn time (falling
-- back to the earliest row, then to the profile) — a late back-fill pays what was
-- promised when the order was paid. Everything else is unchanged from 0051.
create or replace function public.record_affiliate_commission(
  p_referral_id  uuid,
  p_order_id     uuid,
  p_gross_amount numeric,
  p_earned_at    timestamptz default null
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_referrer_id uuid;
  v_referred_id uuid;
  v_created_at timestamptz;
  v_flagged boolean;
  v_affiliate_status text;
  v_deleted boolean;
  v_suspended boolean;
  v_intro_rate numeric;
  v_lifetime_rate numeric;
  v_h_intro numeric;
  v_h_life numeric;
  v_rate numeric;
  v_id uuid;
  v_amt numeric;
  v_first boolean;
begin
  if p_gross_amount is null or p_gross_amount <= 0 then
    return null;
  end if;

  select referrer_id, referred_user_id, created_at, flagged
    into v_referrer_id, v_referred_id, v_created_at, v_flagged
  from public.referrals where id = p_referral_id;

  if v_referrer_id is null or coalesce(v_flagged, false) then
    return null;
  end if;

  select affiliate_status,
         coalesce(affiliate_commission_rate, 0.30),
         coalesce(affiliate_commission_rate_lifetime, 0.15),
         is_deleted, is_suspended
    into v_affiliate_status, v_intro_rate, v_lifetime_rate, v_deleted, v_suspended
  from public.profiles where id = v_referrer_id;

  if v_affiliate_status is distinct from 'approved'
     or coalesce(v_deleted, false) or coalesce(v_suspended, false) then
    return null;
  end if;

  select h.intro_rate, h.lifetime_rate into v_h_intro, v_h_life
  from public.affiliate_rate_history h
  where h.user_id = v_referrer_id and h.effective_from <= coalesce(p_earned_at, now())
  order by h.effective_from desc limit 1;
  if not found then
    select h.intro_rate, h.lifetime_rate into v_h_intro, v_h_life
    from public.affiliate_rate_history h
    where h.user_id = v_referrer_id order by h.effective_from asc limit 1;
  end if;
  v_intro_rate := coalesce(v_h_intro, v_intro_rate);
  v_lifetime_rate := coalesce(v_h_life, v_lifetime_rate);

  v_rate := case when coalesce(p_earned_at, now()) <= v_created_at + interval '90 days' then v_intro_rate else v_lifetime_rate end;

  insert into public.affiliate_commissions
    (referral_id, referrer_id, referred_user_id, order_id, gross_amount_usd, commission_rate, commission_amount_usd)
  values
    (p_referral_id, v_referrer_id, v_referred_id, p_order_id, p_gross_amount, v_rate, round(p_gross_amount * v_rate, 2))
  on conflict (order_id) do nothing
  returning id, commission_amount_usd into v_id, v_amt;

  if v_id is null then
    return null; -- already recorded for this order
  end if;

  v_first := not exists (
    select 1 from public.affiliate_commissions where referral_id = p_referral_id and id <> v_id
  );
  return jsonb_build_object('commission_usd', v_amt, 'rate', v_rate, 'first', v_first);
end;
$$;

-- ── 6. Verified Operator review + performance ──────────────
create table if not exists public.verified_operator_reviews (
  id          uuid default uuid_generate_v4() primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  reviewed_by uuid references public.profiles(id) on delete set null,
  note        text not null,
  reviewed_at timestamptz not null default now()
);
create index if not exists idx_vo_reviews_user on public.verified_operator_reviews(user_id, reviewed_at desc);
alter table public.verified_operator_reviews enable row level security;
revoke all on table public.verified_operator_reviews from anon, authenticated;

create or replace function public.admin_affiliate_performance(p_referrer_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'referrals_total',     (select count(*) from public.referrals where referrer_id = p_referrer_id),
    'referrals_flagged',   (select count(*) from public.referrals where referrer_id = p_referrer_id and flagged),
    'referrals_converted', (select count(distinct referral_id) from public.affiliate_commissions where referrer_id = p_referrer_id and status <> 'void'),
    'gross_90d_usd',       coalesce((select sum(gross_amount_usd) from public.affiliate_commissions
                              where referrer_id = p_referrer_id and status <> 'void' and voided_at is null
                                and created_at >= now() - interval '90 days'), 0),
    'commission_90d_usd',  coalesce((select sum(commission_amount_usd) from public.affiliate_commissions
                              where referrer_id = p_referrer_id and status <> 'void' and voided_at is null
                                and created_at >= now() - interval '90 days'), 0),
    'commissions_voided',  (select count(*) from public.affiliate_commissions where referrer_id = p_referrer_id and (status = 'void' or voided_at is not null)),
    'open_deductions_usd', coalesce((select sum(amount_usd) from public.affiliate_adjustments
                              where referrer_id = p_referrer_id and payout_id is null and waived_at is null), 0)
  );
$$;
revoke all on function public.admin_affiliate_performance(uuid) from public, anon, authenticated;
grant execute on function public.admin_affiliate_performance(uuid) to service_role;

-- ── 7. Reverse a payout marked paid by mistake ─────────────
create or replace function public.admin_reverse_paid_payout(p_payout_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p public.affiliate_payouts%rowtype;
  v_n integer;
begin
  select * into p from public.affiliate_payouts where id = p_payout_id for update;
  if not found or p.status <> 'paid' then
    return null;
  end if;
  -- A commission recovered after payout already produced a deduction; reverting the
  -- payout would count it twice.
  if exists (select 1 from public.affiliate_commissions where payout_id = p.id and voided_at is not null) then
    return jsonb_build_object('blocked', 'voided_commissions');
  end if;

  update public.affiliate_payouts
     set status = 'pending', paid_at = null, paid_by = null, payment_reference = null, notified_at = null
   where id = p.id;
  update public.affiliate_commissions
     set status = 'pending', paid_at = null
   where payout_id = p.id and status = 'paid';
  get diagnostics v_n = row_count;

  return jsonb_build_object(
    'referrer_id', p.referrer_id, 'amount_usd', p.amount_usd,
    'cycle_start', p.cycle_start, 'cycle_end', p.cycle_end,
    'payment_reference', p.payment_reference, 'commissions_reverted', v_n
  );
end;
$$;
revoke all on function public.admin_reverse_paid_payout(uuid) from public, anon, authenticated;
grant execute on function public.admin_reverse_paid_payout(uuid) to service_role;

-- ============================================================
-- 0074_api_integrations_pass4.sql (folded)
-- ============================================================
-- ─────────────────────────────────────────────────────────────────────
-- 0074 · Public API & integrations — independent pass 4
--
--  1. Webhook subscriptions: the wildcard '*' (every event, including ones added
--     later) and three new events — api_key_updated, webhook_endpoint_disabled and
--     reseller_low_stock. COMPLETE list as of 0070 plus those; an event named in
--     lib/webhookEvents.ts but missing here makes the insert/update fail.
--
-- Idempotent. Apply BEFORE / WITH the deploy: until it is applied, saving an
-- endpoint that selects "all events" or one of the new events is rejected by the
-- database (everything already stored keeps working).
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
    'webhook_endpoint_disabled', 'reseller_low_stock'
  ]::text[]);

insert into public.schema_migrations (filename) values
  ('0074_api_integrations_pass4.sql')
on conflict do nothing;

-- ============================================================
-- 0075_cron_deletion_ops.sql (folded)
-- ============================================================
-- ─────────────────────────────────────────────────────────────────────
-- 0075 · Cron, account deletion & ops — independent pass
--
--  1. settle_released_credential(): closing a credential for a DELETED account
--     (self-service, admin, or the retry sweep) now settles the account's bandwidth
--     accounting exactly like deleting a session does (delete_own_credential):
--     unused GB goes back to the balance, consumed GB moves to archived_used_gb.
--     Tombstoned credentials used to keep their allocation (and keep counting in
--     used_gb) forever. Already-deleted accounts are back-filled below.
--  2. Account deletion cool-off: profiles.deletion_requested_at / deletion_scheduled_at
--     / deletion_reminder_sent_at, plus attempt + last-error bookkeeping for the hourly
--     'deletions' task, and deletion_cleanup_pending / deletion_cleanup_notes so a
--     deletion that finished with warnings (something sensitive still on disk, a
--     supplier sub-user that could not be released) is retried and visible instead of
--     existing only in a log line. A customer cannot write any of these directly
--     (the protect trigger below): scheduling goes through the step-up-protected route.
--
-- Idempotent. Apply BEFORE deploying: the deletion route and the hourly 'deletions'
-- task read these columns.
-- ─────────────────────────────────────────────────────────────────────

-- ── 1. Settling released credentials ─────────────────────────────────
alter table public.proxy_credentials add column if not exists settled_at timestamptz;

create or replace function public.settle_released_credential(
  p_credential_id uuid,
  p_live_used_gb numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c         public.proxy_credentials%rowtype;
  v_used    numeric;
  v_release numeric;
begin
  select * into c from public.proxy_credentials where id = p_credential_id for update;
  if not found then
    return jsonb_build_object('skipped', 'not_found');
  end if;
  if c.settled_at is not null then
    return jsonb_build_object('skipped', 'already_settled');
  end if;

  -- The larger of the live figure and the last synced one counts as consumed, so a
  -- failed or stale live read can never hand back too much (same rule as
  -- delete_own_credential).
  v_used    := greatest(coalesce(p_live_used_gb, 0), coalesce(c.gb_used, 0), 0);
  v_release := greatest(0, coalesce(c.gb_allocated, 0) - v_used);

  -- used_gb on the account is (live sessions' gb_used) + archived_used_gb, and a
  -- tombstoned credential is still 'suspended', so its own gb_used must leave the live
  -- sum in the same step it moves to the archive — otherwise it counts twice.
  update public.proxy_credentials
     set gb_allocated = 0, gb_used = 0, settled_at = now()
   where id = c.id;

  update public.bandwidth_accounts
     set allocated_gb     = greatest(0, allocated_gb - v_release),
         archived_used_gb = archived_used_gb + v_used
   where user_id = c.user_id;

  return jsonb_build_object('released_gb', v_release, 'archived_gb', v_used);
end;
$$;

revoke all on function public.settle_released_credential(uuid, numeric) from public, anon, authenticated;
grant execute on function public.settle_released_credential(uuid, numeric) to service_role;

-- Back-fill: credentials of accounts deleted BEFORE this migration. No live figure is
-- available any more, so the synced gb_used is what counts as consumed.
do $$
declare r record;
begin
  for r in
    select id from public.proxy_credentials
    where suspended_reason = 'deleted' and settled_at is null
  loop
    perform public.settle_released_credential(r.id, null);
  end loop;
end $$;

-- ── 2. Account deletion cool-off + cleanup bookkeeping ───────────────
alter table public.profiles add column if not exists deletion_requested_at      timestamptz;
alter table public.profiles add column if not exists deletion_scheduled_at      timestamptz;
alter table public.profiles add column if not exists deletion_reminder_sent_at  timestamptz;
alter table public.profiles add column if not exists deletion_attempts          integer not null default 0;
alter table public.profiles add column if not exists deletion_last_error        text;
alter table public.profiles add column if not exists deletion_cleanup_pending   boolean not null default false;
alter table public.profiles add column if not exists deletion_cleanup_notes     text;

create index if not exists profiles_deletion_scheduled_idx
  on public.profiles (deletion_scheduled_at) where deletion_scheduled_at is not null;
create index if not exists profiles_deletion_cleanup_idx
  on public.profiles (deleted_at) where deletion_cleanup_pending;

-- "Update own profile" has no column restriction, so without this a signed-in browser
-- could schedule its own deletion (skipping the step-up the route demands) or clear
-- the cleanup flag after a deletion. Service-role writes (auth.uid() is null) and
-- admins pass through, as in protect_payout_hold_reason().
create or replace function public.protect_deletion_columns()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return new; -- service-role client
  end if;
  if public.is_admin(auth.uid()) then
    return new;
  end if;
  new.deletion_requested_at     := old.deletion_requested_at;
  new.deletion_scheduled_at     := old.deletion_scheduled_at;
  new.deletion_reminder_sent_at := old.deletion_reminder_sent_at;
  new.deletion_attempts         := old.deletion_attempts;
  new.deletion_last_error       := old.deletion_last_error;
  new.deletion_cleanup_pending  := old.deletion_cleanup_pending;
  new.deletion_cleanup_notes    := old.deletion_cleanup_notes;
  return new;
end;
$$;
revoke all on function public.protect_deletion_columns() from public, anon, authenticated;

drop trigger if exists trg_protect_deletion_columns on public.profiles;
create trigger trg_protect_deletion_columns
  before update on public.profiles
  for each row execute function public.protect_deletion_columns();

insert into public.schema_migrations (filename) values
  ('0075_cron_deletion_ops.sql')
on conflict do nothing;

-- ============================================================
-- 0076_payments_billing_pass4.sql (folded)
-- ============================================================
-- ============================================================
-- 0076 — Payments & billing close-out (audit section 3, round 4)
-- ============================================================
-- 1. payment_holds: an account that LOST a chargeback can no longer buy until an
--    admin clears the hold (before this only an OPEN dispute paused purchases, so
--    buy -> use -> chargeback could repeat once per lost dispute).
-- 2. orders.dispute_reminded_at: throttles the admin alert for Paystack's
--    charge.dispute.remind (sent every 4 hours while a dispute is unanswered).
-- 3. orders.tax_rate_pct / tax_label: the VAT (or similar) rate in force when the
--    order was placed, frozen onto the order so a later rate change never rewrites
--    an invoice. NULL = no tax line (the default).
-- 4. Auto-recharge: saved_cards (a reusable Paystack authorization the customer
--    agreed to save at checkout) and auto_recharge (their settings). Both are
--    service-role only — the authorization code is a secret — and are read through
--    /api/dashboard/billing/auto-recharge. orders.auto_recharge marks the orders the
--    cron placed.
-- 5. protect_order_columns() pins the new order columns against customer writes.

-- ── orders ──────────────────────────────────────────────────
alter table public.orders add column if not exists dispute_reminded_at timestamptz;
alter table public.orders add column if not exists tax_rate_pct numeric;
alter table public.orders add column if not exists tax_label text;
alter table public.orders add column if not exists auto_recharge boolean not null default false;

alter table public.orders drop constraint if exists orders_tax_rate_check;
alter table public.orders add constraint orders_tax_rate_check
  check (tax_rate_pct is null or (tax_rate_pct >= 0 and tax_rate_pct <= 100));

-- ── payment_holds ───────────────────────────────────────────
create table if not exists public.payment_holds (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  reason     text not null check (char_length(reason) between 3 and 300),
  source     text not null default 'dispute_lost' check (source in ('dispute_lost', 'admin')),
  order_id   uuid references public.orders(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.payment_holds enable row level security;
-- The customer may see that a hold exists (Billing explains it); writes are service role only.
drop policy if exists "Own payment hold" on public.payment_holds;
create policy "Own payment hold" on public.payment_holds for select using (auth.uid() = user_id);

-- ── saved_cards / auto_recharge ─────────────────────────────
create table if not exists public.saved_cards (
  user_id            uuid primary key references public.profiles(id) on delete cascade,
  authorization_code text not null,
  email              text not null,
  brand              text,
  last4              text,
  exp_month          text,
  exp_year           text,
  signature          text,
  consent_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
alter table public.saved_cards enable row level security; -- no policies: service role only

create table if not exists public.auto_recharge (
  user_id              uuid primary key references public.profiles(id) on delete cascade,
  enabled              boolean not null default false,
  threshold_gb         numeric not null default 5 check (threshold_gb >= 1 and threshold_gb <= 500),
  plan_slug            text not null default 'starter',
  gb                   integer,                     -- only for plan_slug = 'custom'
  monthly_cap_usd      numeric not null default 100 check (monthly_cap_usd >= 1 and monthly_cap_usd <= 5000),
  consecutive_failures integer not null default 0,
  last_attempt_at      timestamptz,
  last_order_id        uuid references public.orders(id) on delete set null,
  disabled_reason      text,
  cap_notified_at      timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
alter table public.auto_recharge enable row level security; -- no policies: service role only
create index if not exists auto_recharge_enabled_idx on public.auto_recharge (last_attempt_at nulls first) where enabled;
create index if not exists orders_auto_recharge_idx on public.orders (user_id, created_at) where auto_recharge;

-- ── protect_order_columns ───────────────────────────────────
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

  new.user_id                      := old.user_id;
  new.plan_id                      := old.plan_id;
  new.gb_amount                    := old.gb_amount;
  new.amount_usd                   := old.amount_usd;
  new.payment_method               := old.payment_method;
  new.paystack_reference           := old.paystack_reference;
  new.bandwidth_credited           := old.bandwidth_credited;
  new.paid_at                      := old.paid_at;
  new.created_at                   := old.created_at;
  new.invoice_number               := old.invoice_number;
  new.failure_reason               := old.failure_reason;
  new.failed_at                    := old.failed_at;
  new.is_canary                    := old.is_canary;
  new.refunded_usd                 := old.refunded_usd;
  new.refunded_at                  := old.refunded_at;
  new.reconcile_checked_at         := old.reconcile_checked_at;
  new.post_credit_done_at          := old.post_credit_done_at;
  new.billing_details              := old.billing_details;
  new.dispute_status               := old.dispute_status;
  new.dispute_opened_at            := old.dispute_opened_at;
  new.dispute_resolution           := old.dispute_resolution;
  new.pay_currency                 := old.pay_currency;
  new.pay_amount                   := old.pay_amount;
  new.fx_rate                      := old.fx_rate;
  new.plan_slug                    := old.plan_slug;
  new.refund_requested_at          := old.refund_requested_at;
  new.billing_details_revision     := old.billing_details_revision;
  new.billing_details_updated_at   := old.billing_details_updated_at;
  new.mismatch_alerted_at          := old.mismatch_alerted_at;
  new.dispute_reminded_at          := old.dispute_reminded_at;
  new.tax_rate_pct                 := old.tax_rate_pct;
  new.tax_label                    := old.tax_label;
  new.auto_recharge                := old.auto_recharge;

  return new;
end;
$$;

insert into public.schema_migrations (filename) values
  ('0076_payments_billing_pass4.sql')
on conflict do nothing;

-- ============================================================
-- 0077_auth_mfa_pass6.sql (folded)
-- ============================================================
-- ─────────────────────────────────────────────────────────────────────
-- 0077 · Auth & MFA — independent pass 6
--  At most ONE open (not cancelled, not completed) 2FA recovery request per
--  account. requestRecovery() was check-then-insert, so two concurrent
--  requests could leave two live confirmation links. The app maps the unique
--  violation to its "already in progress" message.
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────
update public.mfa_recovery_requests r
   set cancelled_at = now()
 where r.cancelled_at is null and r.completed_at is null
   and exists (
     select 1 from public.mfa_recovery_requests n
      where n.user_id = r.user_id and n.cancelled_at is null and n.completed_at is null
        and (n.created_at, n.id) > (r.created_at, r.id)
   );

create unique index if not exists mfa_recovery_requests_one_open_idx
  on public.mfa_recovery_requests (user_id)
  where cancelled_at is null and completed_at is null;

insert into public.schema_migrations (filename) values
  ('0077_auth_mfa_pass6.sql')
on conflict do nothing;
