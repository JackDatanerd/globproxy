-- ============================================================
-- 0035 — M-Pesa as a third payout method
-- ============================================================
-- Same pattern as usdt/bank from migration 0034: a phone number field on
-- profiles, protected by protect_privileged_profile_columns exactly like
-- every other payout field (only the update-payout-method route can set
-- it, always alongside a fresh payout_method_updated_at — the 48h hold
-- doesn't care which method changed, all three are covered by the same
-- check), and a snapshot column on affiliate_payouts so a later phone
-- number change never retroactively edits where a past payout was sent.
--
-- Safe to run against the live DB: idempotent, purely additive.

alter table public.profiles drop constraint if exists profiles_payout_method_check;
alter table public.profiles add constraint profiles_payout_method_check
  check (payout_method is null or payout_method in ('usdt', 'bank', 'mpesa'));

alter table public.profiles add column if not exists payout_mpesa_phone text;

alter table public.affiliate_payouts add column if not exists payout_mpesa_phone text;

-- protect_privileged_profile_columns: full body again (CREATE OR REPLACE
-- replaces the whole function), plus payout_mpesa_phone alongside the
-- other four payout columns it already protects.
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
  new.email                              := old.email; -- see migration 0011 — the sync trigger is how email changes actually land
  new.affiliate_status                   := old.affiliate_status; -- see migration 0031
  new.affiliate_commission_rate          := old.affiliate_commission_rate;
  new.affiliate_commission_rate_lifetime := old.affiliate_commission_rate_lifetime;
  new.payout_method                      := old.payout_method; -- see migration 0034, extended by 0035
  new.payout_wallet_address              := old.payout_wallet_address;
  new.payout_wallet_network              := old.payout_wallet_network;
  new.payout_bank_details                := old.payout_bank_details;
  new.payout_mpesa_phone                 := old.payout_mpesa_phone;
  new.payout_method_updated_at           := old.payout_method_updated_at;

  return new;
end;
$$;

-- run_affiliate_payout_cycle needs to carry the phone number onto new
-- payout rows too, same as it already does for wallet/bank fields.
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
begin
  for r in
    select ac.referrer_id as rid, sum(ac.commission_amount_usd) as total
    from public.affiliate_commissions ac
    where ac.payout_id is null
      and ac.status = 'pending'
      and ac.created_at::date between p_cycle_start and p_cycle_end
    group by ac.referrer_id
  loop
    select payout_method, payout_method_updated_at, payout_wallet_address, payout_wallet_network, payout_bank_details, payout_mpesa_phone
      into v_method, v_method_updated, v_wallet_address, v_wallet_network, v_bank, v_mpesa_phone
    from public.profiles where id = r.rid;

    if v_method is null then
      v_status := 'no_payout_method';
    elsif v_method_updated is null or v_method_updated > (now() - (p_hold_hours || ' hours')::interval) then
      v_status := 'held_recent_method';
    elsif r.total < p_min_payout_usd then
      v_status := 'below_minimum';
    else
      v_status := 'created';
    end if;

    v_new_payout_id := null;

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
        update public.affiliate_commissions
        set payout_id = v_new_payout_id
        where referrer_id = r.rid
          and payout_id is null
          and status = 'pending'
          and created_at::date between p_cycle_start and p_cycle_end;
      else
        v_status := 'already_run';
      end if;
    end if;

    out_referrer_id := r.rid;
    out_status := v_status;
    out_amount_usd := r.total;
    out_payout_id := v_new_payout_id;
    return next;
  end loop;
end;
$$;

insert into public.schema_migrations (filename) values
  ('0035_mpesa_payout_method.sql')
on conflict do nothing;
