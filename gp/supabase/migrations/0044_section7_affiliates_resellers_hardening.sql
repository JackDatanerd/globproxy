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
