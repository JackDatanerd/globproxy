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
