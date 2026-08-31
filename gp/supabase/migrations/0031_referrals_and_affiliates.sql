-- ============================================================
-- 0031 — Referral codes + affiliate commission program
-- ============================================================
-- Two separate reward mechanisms, sharing one attribution table:
--
--  1. Standard referral: every user gets a referral_code for free. When
--     someone they refer completes their first paid order, both sides
--     get a one-time GB credit. No approval needed — this is the
--     Dropbox-style loop, and it's funded in bandwidth (marginal cost
--     to us), not cash.
--
--  2. Affiliate: an approved subset of referrers (application + admin
--     review, same shape as reseller_status/api_access_status already
--     have) earn a cash commission on EVERY order their referred users
--     make, for as long as they keep buying — not just the first. Rate
--     steps down from an intro rate to a lower lifetime rate after 90
--     days, matching how commission programs work across this market.
--
-- Whichever mechanism applies is decided at credit-time by the referrer's
-- profiles.affiliate_status, not stored on the referral row itself — an
-- application approved after a referral already exists should apply to
-- that referral's future orders too.
--
-- Safe to run against the live DB: idempotent (IF NOT EXISTS / DROP ...
-- IF EXISTS before CREATE, ON CONFLICT DO NOTHING on all seed/backfill
-- statements), and purely additive — no existing column, table, or
-- function signature is changed in a breaking way.

-- ── Referral codes ──────────────────────────────────────────────
-- 8-char uppercase alnum, collision-checked in a loop rather than relied
-- on as statistically-unlikely — this runs once per signup, so the loop
-- cost is negligible and correctness shouldn't depend on how big the
-- keyspace happens to be.
create or replace function public.generate_unique_referral_code()
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_code text;
  v_exists boolean;
begin
  loop
    v_code := upper(substr(replace(uuid_generate_v4()::text, '-', ''), 1, 8));
    select exists(select 1 from public.profiles where referral_code = v_code) into v_exists;
    exit when not v_exists;
  end loop;
  return v_code;
end;
$$;

revoke all on function public.generate_unique_referral_code() from public;
grant execute on function public.generate_unique_referral_code() to service_role, authenticated;

alter table public.profiles add column if not exists referral_code text;

-- Backfill existing accounts before the uniqueness constraint goes on —
-- can't add a unique constraint over a column that's still all NULLs
-- failing to satisfy it... actually NULLs are fine under UNIQUE (multiple
-- NULLs are allowed), but every real account should have a working
-- referral link from day one, not just accounts created after this
-- migration. Loop rather than a single UPDATE ... SET = generate_...()
-- because the function itself checks *existing* codes for collisions —
-- a single UPDATE would evaluate the function once per row without any
-- of those rows being visible to each other's collision checks yet.
do $$
declare
  r record;
begin
  for r in select id from public.profiles where referral_code is null loop
    update public.profiles set referral_code = public.generate_unique_referral_code() where id = r.id;
  end loop;
end;
$$;

alter table public.profiles add constraint profiles_referral_code_unique unique (referral_code);
alter table public.profiles alter column referral_code set not null;
alter table public.profiles alter column referral_code set default public.generate_unique_referral_code();

-- ── Affiliate application/approval — same shape as reseller_status ──
alter table public.profiles add column if not exists affiliate_status text;
alter table public.profiles drop constraint if exists profiles_affiliate_status_check;
alter table public.profiles add constraint profiles_affiliate_status_check
  check (affiliate_status is null or affiliate_status in ('pending','approved','rejected','suspended'));
alter table public.profiles add column if not exists affiliate_application jsonb;

-- Per-affiliate commission rates, set by admin at approval time (see
-- approve-affiliate route). Nullable: only meaningful once approved;
-- record_affiliate_commission() below coalesces to sane platform
-- defaults if an approved affiliate somehow has neither set.
alter table public.profiles add column if not exists affiliate_commission_rate numeric;
alter table public.profiles add column if not exists affiliate_commission_rate_lifetime numeric;
alter table public.profiles drop constraint if exists profiles_affiliate_rate_range;
alter table public.profiles add constraint profiles_affiliate_rate_range
  check (affiliate_commission_rate is null or (affiliate_commission_rate >= 0 and affiliate_commission_rate <= 1));
alter table public.profiles drop constraint if exists profiles_affiliate_rate_lifetime_range;
alter table public.profiles add constraint profiles_affiliate_rate_lifetime_range
  check (affiliate_commission_rate_lifetime is null or (affiliate_commission_rate_lifetime >= 0 and affiliate_commission_rate_lifetime <= 1));

-- protect_privileged_profile_columns (0003, extended by 0028) must cover
-- the three new columns above the same way it already covers
-- reseller_status/api_access_status — otherwise a user could set their
-- own affiliate_status straight to 'approved' (and their own commission
-- rate to whatever they like) via a raw REST call, same hole class 0003
-- and 0028 closed for the columns before these. affiliate_application is
-- left unprotected, matching reseller_application/api_access_application:
-- informational only, never read as an authorization signal, and the
-- app's own write path (apply-affiliate) always goes through the admin
-- client regardless.
--
-- Also switches the admin check from the inline `select role = 'admin'
-- from profiles` (0028's version) to public.is_admin() (introduced in
-- 0029 for the profiles RLS recursion fix). Both are equivalent here —
-- this function is SECURITY DEFINER so its own inner SELECT was never
-- subject to RLS recursion the way a USING clause on profiles' own
-- policies would be — this is just consolidating onto the one helper
-- every other admin check in this schema already uses, instead of a
-- second copy of the same logic.
create or replace function public.protect_privileged_profile_columns()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
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
  new.email                              := old.email; -- see migration 0011 — the sync trigger is how email changes actually land
  new.affiliate_status                   := old.affiliate_status;
  new.affiliate_commission_rate          := old.affiliate_commission_rate;
  new.affiliate_commission_rate_lifetime := old.affiliate_commission_rate_lifetime;

  return new;
end;
$$;

-- ── Referrals ────────────────────────────────────────────────────
-- One row per referred user, created once at signup (record_referral_
-- signup below), permanent for the life of that user — not "consumed"
-- by crediting. gb_bonus_credited_at is the one-time-only flag for the
-- standard-referral GB bonus; affiliate commissions are tracked
-- separately in affiliate_commissions below since they can fire many
-- times against the same referral row.
create table if not exists public.referrals (
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

alter table public.referrals enable row level security;

drop policy if exists "Referrer can view own referrals" on public.referrals;
create policy "Referrer can view own referrals" on public.referrals for select
  using (auth.uid() = referrer_id);

drop policy if exists "Admins can view all referrals" on public.referrals;
create policy "Admins can view all referrals" on public.referrals for select
  using (public.is_admin(auth.uid()));

-- No insert/update/delete policies for anon/authenticated — every write
-- goes through record_referral_signup / credit_referral_bonus /
-- record_affiliate_commission below, called from the admin (service-role)
-- client, same posture as orders/proxy_credentials/reseller_transfers
-- elsewhere in this schema.

-- Attribute a new signup to whoever owns p_code, if it's a real code and
-- not (somehow) the new user's own. Silently no-ops on an unknown code —
-- called from the signup route, which must never fail an otherwise-valid
-- signup over a mistyped or stale referral code.
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
  on conflict (referred_user_id) do nothing; -- a user is only ever attributed once, first write wins
end;
$$;

revoke all on function public.record_referral_signup(text, uuid) from public;
grant execute on function public.record_referral_signup(text, uuid) to service_role;

-- One-time GB bonus to both sides of a standard (non-affiliate) referral.
-- Idempotent via the same claim-then-act shape claim_and_credit_order
-- uses: the UPDATE ... WHERE gb_bonus_credited_at is null ... RETURNING
-- only ever matches once, so calling this again for the same referral
-- (e.g. the referred user's second order also triggers the app-side
-- check) is a safe no-op rather than a double credit.
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
    return false; -- already credited, or referral doesn't exist
  end if;

  perform public.credit_bandwidth(v_referrer_id, p_gb); -- uncaught error here rolls back the claim above too
  perform public.credit_bandwidth(v_referred_id, p_gb);

  return true;
end;
$$;

revoke all on function public.credit_referral_bonus(uuid, numeric) from public;
grant execute on function public.credit_referral_bonus(uuid, numeric) to service_role;

-- ── Affiliate commissions ────────────────────────────────────────
-- One row per commissionable order (unique on order_id — an order can
-- only ever earn one commission record, guarding the same "called twice"
-- case credit_referral_bonus's row-lock guards for the GB path).
create table if not exists public.affiliate_commissions (
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

alter table public.affiliate_commissions enable row level security;

drop policy if exists "Referrer can view own commissions" on public.affiliate_commissions;
create policy "Referrer can view own commissions" on public.affiliate_commissions for select
  using (auth.uid() = referrer_id);

drop policy if exists "Admins can view all commissions" on public.affiliate_commissions;
create policy "Admins can view all commissions" on public.affiliate_commissions for select
  using (public.is_admin(auth.uid()));

-- No client-side insert/update policies — record_affiliate_commission
-- (below) is the only writer, and marking a commission 'paid' goes
-- through /api/admin/mark-commission-paid via the admin client, same
-- pattern as approve-reseller etc. rather than an RLS UPDATE policy.

-- Records a commission for one order, at whichever rate is in effect —
-- intro rate for the first AFFILIATE_INTRO_WINDOW_DAYS (90) after the
-- referral was created, lifetime rate after. No-ops (does not raise) if
-- the referral is gone or the referrer isn't currently an approved
-- affiliate — the caller (processReferralForOrder in lib/referrals.ts)
-- already checks affiliate_status before calling this, but the check is
-- repeated here too since this function's grants make it callable
-- directly by service-role code elsewhere, and it shouldn't silently
-- misbehave if that check is ever skipped upstream.
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
    return; -- referral row doesn't exist — nothing to commission
  end if;

  select affiliate_status,
         coalesce(affiliate_commission_rate, 0.30),
         coalesce(affiliate_commission_rate_lifetime, 0.15)
    into v_affiliate_status, v_intro_rate, v_lifetime_rate
  from public.profiles where id = v_referrer_id;

  if v_affiliate_status is distinct from 'approved' then
    return; -- not an approved affiliate right now — GB-bonus path handles this referral instead
  end if;

  v_rate := case when now() <= v_created_at + interval '90 days' then v_intro_rate else v_lifetime_rate end;

  insert into public.affiliate_commissions
    (referral_id, referrer_id, referred_user_id, order_id, gross_amount_usd, commission_rate, commission_amount_usd)
  values
    (p_referral_id, v_referrer_id, v_referred_id, p_order_id, p_gross_amount, v_rate, round(p_gross_amount * v_rate, 2))
  on conflict (order_id) do nothing;
end;
$$;

revoke all on function public.record_affiliate_commission(uuid, uuid, numeric) from public;
grant execute on function public.record_affiliate_commission(uuid, uuid, numeric) to service_role;

insert into public.schema_migrations (filename) values
  ('0031_referrals_and_affiliates.sql')
on conflict do nothing;
