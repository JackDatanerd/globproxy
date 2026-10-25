-- ─────────────────────────────────────────────────────────────────────
-- 0080 · Reseller, affiliates & payouts — independent pass 7
--
--  1. run_affiliate_payout_cycle: the re-check after claiming also enforces the
--     minimum (a refund between the eligibility check and the claim could leave a
--     payout below it).
--  2. One daily new-recipient budget (50) for registered clients AND invitations:
--     create_pending_reseller_transfer now uses reseller_new_recipients_24h, and
--     allocate_reseller_bandwidth_tx enforces it atomically under the stock lock.
--  3. Referral-bonus clawbacks are queued (referral_bonus_reversal_events) so the
--     hourly sweep can send the webhooks / e-mail the trigger cannot.
--  4. reduce_pending_reseller_transfer: lower an open invitation instead of
--     cancelling and re-creating it.
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────

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
        if v_net <= 0 or v_net < p_min_payout_usd then
          -- A refund landed between the check and the claim, and what is really
          -- left is nothing or under the minimum. Undo: the FKs release the
          -- commissions and adjustments for the next cycle.
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
    v_new24 := public.reseller_new_recipients_24h(p_reseller_id);
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
  v_new24 integer;
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

  -- A NEW client draws on the daily new-recipient budget (shared with invitations).
  -- Checked here, under the reseller's stock lock, so concurrent calls cannot all
  -- pass a check that was made before any of them committed.
  if not exists (select 1 from public.reseller_transfers where reseller_id = p_reseller_id and recipient_id = p_recipient_id) then
    v_new24 := public.reseller_new_recipients_24h(p_reseller_id);
    if v_new24 >= 50 then
      raise exception 'Too many new recipients today — try again tomorrow.';
    end if;
  end if;

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

create table if not exists public.referral_bonus_reversal_events (
  referral_id       uuid primary key references public.referrals(id) on delete cascade,
  referrer_id       uuid not null references public.profiles(id) on delete cascade,
  referred_user_id  uuid not null references public.profiles(id) on delete cascade,
  gb_from_referrer  numeric not null default 0,
  gb_from_referred  numeric not null default 0,
  created_at        timestamptz not null default now(),
  notified_at       timestamptz
);
create index if not exists idx_referral_bonus_reversal_unnotified
  on public.referral_bonus_reversal_events (created_at) where notified_at is null;
alter table public.referral_bonus_reversal_events enable row level security;
revoke all on table public.referral_bonus_reversal_events from anon, authenticated;

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

  -- A trigger cannot call a webhook: queue the clawback so the hourly sweep can tell
  -- both accounts (their ledgers otherwise never learn the bonus was taken back).
  if v_claw_a > 0 or v_claw_b > 0 then
    insert into public.referral_bonus_reversal_events (referral_id, referrer_id, referred_user_id, gb_from_referrer, gb_from_referred)
    values (r.id, r.referrer_id, r.referred_user_id, v_claw_a, v_claw_b)
    on conflict (referral_id) do nothing;
  end if;

  insert into public.admin_audit_log (admin_id, action, target_user_id, target_ref, details)
  values (null, 'referral_bonus_reversed', r.referrer_id, new.id::text,
          jsonb_build_object('referral_id', r.id, 'bonus_gb', r.gb_bonus_amount,
                             'clawed_from_referrer_gb', v_claw_a, 'clawed_from_referred_gb', v_claw_b,
                             'order_refunded_usd', new.refunded_usd, 'order_amount_usd', new.amount_usd));
  return new;
end;
$$;

create or replace function public.reduce_pending_reseller_transfer(p_id uuid, p_reseller_id uuid, p_gb numeric)
returns table (out_result text, out_gb numeric, out_returned_gb numeric)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p public.reseller_pending_transfers%rowtype;
begin
  if p_gb is null or p_gb < 0.1 then raise exception 'Minimum allocation is 0.1 GB'; end if;
  if p_gb <> round(p_gb, 3) then raise exception 'At most 3 decimal places are allowed'; end if;
  -- Same lock order as cancel/create: the stock row first, then the invitation.
  perform 1 from public.bandwidth_accounts where user_id = p_reseller_id for update;
  select * into p from public.reseller_pending_transfers
  where id = p_id and reseller_id = p_reseller_id and status = 'pending' for update;
  if not found then
    return query select 'not_found'::text, null::numeric, null::numeric; return;
  end if;
  if p_gb >= p.gb_amount then
    return query select 'not_lower'::text, p.gb_amount, null::numeric; return;
  end if;
  update public.bandwidth_accounts
  set allocated_gb = greatest(allocated_gb - (p.gb_amount - p_gb), 0) where user_id = p.reseller_id;
  update public.reseller_pending_transfers set gb_amount = p_gb where id = p.id;
  return query select 'ok'::text, p_gb, p.gb_amount - p_gb;
end;
$$;
revoke all on function public.reduce_pending_reseller_transfer(uuid, uuid, numeric) from public, anon, authenticated;
grant execute on function public.reduce_pending_reseller_transfer(uuid, uuid, numeric) to service_role;


insert into public.schema_migrations (filename) values
  ('0080_reseller_affiliates_pass7.sql')
on conflict do nothing;
