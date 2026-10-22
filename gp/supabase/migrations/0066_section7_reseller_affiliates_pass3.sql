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
