-- ─────────────────────────────────────────────────────────────────────
-- 0078 · Reseller, affiliates & payouts — independent pass 6
--  1. reclaim_reseller_allocation: what the client has committed to credentials
--     is attributed to THIS reseller's bandwidth first (oldest transfer first), so a
--     client's own unassigned balance can no longer be swept back in its place.
--  2. claim_pending_reseller_transfers: the inviting account must still hold the
--     reseller (or admin) role; demoting a reseller cancels their open invitations
--     and releases the reserved stock.
--  3. Reseller-sent GB the client never used returns to the reseller when the client
--     deletes the account (scrub_affiliate_data).
--  4. remind_pending_reseller_transfer returns the previous reminder time and
--     refund_pending_reseller_reminder gives the slot back when the e-mail could not
--     be sent.
--  5. reseller_new_recipients_24h no longer counts a claimed invitation twice.
--  6. my_referral_funnel: stable order (id tiebreak) for paging.
--  7. affiliate_payouts records the local (KES) amount and rate of M-Pesa payouts;
--     my_payout_breakdown() gives each payout's commissions and deductions.
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────

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
  v_alloc numeric;
  v_before numeric;
  v_pool numeric;
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
  select greatest(coalesce(available_gb, 0), 0), greatest(coalesce(allocated_gb, 0), 0) into v_avail, v_alloc
  from public.bandwidth_accounts where user_id = t.recipient_id;
  v_avail := coalesce(v_avail, 0);
  v_alloc := coalesce(v_alloc, 0);

  -- What the client has already committed to credentials is attributed to the
  -- bandwidth THIS reseller sent first, oldest transfer first (the same rule the
  -- roster uses for "used"). The client's own, unrelated unassigned balance can
  -- therefore never be swept back to the reseller in place of GB the client has
  -- since put to work (0078: a client holding 100 GB of their own plus a 5 GB gift,
  -- all 5 committed, lost 5 GB of their own on reclaim).
  select coalesce(sum(x.gb_amount - x.reclaimed_gb), 0) into v_before
  from public.reseller_transfers x
  where x.reseller_id = t.reseller_id and x.recipient_id = t.recipient_id and x.status = 'active'
    and (x.created_at, x.id) < (t.created_at, t.id);
  v_pool := v_remaining - greatest(least(v_alloc, v_before + v_remaining) - v_before, 0);

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

  v_amount := least(v_remaining, greatest(v_avail - v_later, 0), greatest(v_pool, 0));
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
      -- The inviting reseller must still be an active reseller (0078: role too); otherwise the
      -- invitation waits (and expires, returning the stock) rather than moving
      -- bandwidth on behalf of a suspended or closed reseller.
      and exists (select 1 from public.profiles rs
                  where rs.id = t.reseller_id and not coalesce(rs.is_deleted, false) and not coalesce(rs.is_suspended, false)
                    and rs.role in ('reseller', 'admin'))
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

-- Demotion: a user who is no longer a reseller can't have invitations moving stock.
create or replace function public.cancel_open_invites_on_demote()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p record;
begin
  perform 1 from public.bandwidth_accounts where user_id = new.id for update;
  for p in
    select * from public.reseller_pending_transfers
    where reseller_id = new.id and status = 'pending' order by created_at for update
  loop
    update public.bandwidth_accounts set allocated_gb = greatest(allocated_gb - p.gb_amount, 0) where user_id = p.reseller_id;
    update public.reseller_pending_transfers
    set status = 'cancelled', resolved_at = now(), notified_at = now()
    where id = p.id;
  end loop;
  return null;
end;
$$;
revoke all on function public.cancel_open_invites_on_demote() from public, anon, authenticated;
drop trigger if exists trg_cancel_open_invites_on_demote on public.profiles;
create trigger trg_cancel_open_invites_on_demote
  after update of role on public.profiles
  for each row when (old.role = 'reseller' and new.role is distinct from 'reseller' and new.role is distinct from 'admin')
  execute function public.cancel_open_invites_on_demote();

-- Closed client account: unused reseller-sent GB goes back to the reseller.
create or replace function public.return_reseller_stock_on_client_delete(p_client uuid)
returns numeric language plpgsql security definer set search_path = public, pg_temp as $$
declare
  t       record;
  v_avail numeric;
  v_amt   numeric;
  v_total numeric := 0;
begin
  for t in
    select id, reseller_id, gb_amount - reclaimed_gb as rem
    from public.reseller_transfers
    where recipient_id = p_client and status = 'active' and gb_amount - reclaimed_gb > 0
    order by created_at desc, id desc
  loop
    perform 1 from public.bandwidth_accounts where user_id in (t.reseller_id, p_client) order by user_id for update;
    select greatest(coalesce(available_gb, 0), 0) into v_avail from public.bandwidth_accounts where user_id = p_client;
    v_amt := round(least(t.rem, coalesce(v_avail, 0)), 3);
    if v_amt > 0 then
      update public.bandwidth_accounts set total_gb = total_gb - v_amt where user_id = p_client;
      update public.bandwidth_accounts set allocated_gb = greatest(allocated_gb - v_amt, 0) where user_id = t.reseller_id;
      update public.reseller_transfers
      set reclaimed_gb = reclaimed_gb + v_amt,
          status = case when reclaimed_gb + v_amt >= gb_amount then 'reclaimed' else status end
      where id = t.id;
      v_total := v_total + v_amt;
    end if;
  end loop;
  return v_total;
end;
$$;
revoke all on function public.return_reseller_stock_on_client_delete(uuid) from public, anon, authenticated;
grant execute on function public.return_reseller_stock_on_client_delete(uuid) to service_role;

create or replace function public.scrub_affiliate_data(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r           public.affiliate_payouts%rowtype;
  v_payouts   jsonb   := '[]'::jsonb;
  v_forfeited numeric := 0;
begin
  -- 0078: unused bandwidth a reseller sent this client goes back to the reseller.
  perform public.return_reseller_stock_on_client_delete(p_user_id);

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

-- Reminders: hand the slot back when the e-mail did not go out.
drop function if exists public.remind_pending_reseller_transfer(uuid, uuid, integer, integer);
create or replace function public.remind_pending_reseller_transfer(
  p_id uuid, p_reseller_id uuid, p_cooldown_hours integer default 24, p_max integer default 3
)
returns table (out_result text, out_email text, out_gb numeric, out_expires_at timestamptz, out_retry_at timestamptz, out_prev_reminded_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p public.reseller_pending_transfers%rowtype;
  v_next timestamptz;
begin
  select * into p from public.reseller_pending_transfers
  where id = p_id and reseller_id = p_reseller_id and status = 'pending' for update;
  if not found or p.expires_at <= now() then
    return query select 'not_found'::text, null::text, null::numeric, null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;
  if p.reminder_count >= p_max then
    return query select 'limit'::text, p.recipient_email, p.gb_amount, p.expires_at, null::timestamptz, null::timestamptz;
    return;
  end if;
  v_next := coalesce(p.last_reminded_at, p.created_at) + make_interval(hours => p_cooldown_hours);
  if v_next > now() then
    return query select 'cooldown'::text, p.recipient_email, p.gb_amount, p.expires_at, v_next, null::timestamptz;
    return;
  end if;
  update public.reseller_pending_transfers
  set last_reminded_at = now(), reminder_count = reminder_count + 1
  where id = p.id;
  return query select 'ok'::text, p.recipient_email, p.gb_amount, p.expires_at, null::timestamptz, p.last_reminded_at;
end;
$$;
revoke all on function public.remind_pending_reseller_transfer(uuid, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.remind_pending_reseller_transfer(uuid, uuid, integer, integer) to service_role;

create or replace function public.refund_pending_reseller_reminder(p_id uuid, p_reseller_id uuid, p_prev_at timestamptz)
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.reseller_pending_transfers
  set reminder_count = greatest(reminder_count - 1, 0), last_reminded_at = p_prev_at
  where id = p_id and reseller_id = p_reseller_id and status = 'pending';
$$;
revoke all on function public.refund_pending_reseller_reminder(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.refund_pending_reseller_reminder(uuid, uuid, timestamptz) to service_role;

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
      and status <> 'claimed'
  )::integer;
$$;
revoke all on function public.reseller_new_recipients_24h(uuid) from public, anon, authenticated;
grant execute on function public.reseller_new_recipients_24h(uuid) to service_role;

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
  order by r.created_at desc, r.id desc
  limit least(greatest(p_limit, 1), 100) offset greatest(p_offset, 0);
$$;
revoke all on function public.my_referral_funnel(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.my_referral_funnel(uuid, integer, integer) to service_role;

-- M-Pesa payouts: what was actually sent, in shillings, and at what rate.
alter table public.affiliate_payouts
  add column if not exists payout_local_currency text,
  add column if not exists payout_local_amount   numeric,
  add column if not exists payout_fx_rate        numeric;

-- One row per payout: what is in it (commissions) and what was netted off it (deductions).
create or replace function public.my_payout_breakdown(p_user_id uuid)
returns table (payout_id uuid, commissions_usd numeric, commission_count bigint, deductions_usd numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  select p.id,
         coalesce((select sum(c.commission_amount_usd) from public.affiliate_commissions c where c.payout_id = p.id and c.status <> 'void'), 0),
         coalesce((select count(*) from public.affiliate_commissions c where c.payout_id = p.id and c.status <> 'void'), 0),
         coalesce((select -sum(a.amount_usd) from public.affiliate_adjustments a where a.payout_id = p.id), 0)
  from (select id from public.affiliate_payouts where referrer_id = p_user_id order by created_at desc, id desc limit 60) p;
$$;
revoke all on function public.my_payout_breakdown(uuid) from public, anon, authenticated;
grant execute on function public.my_payout_breakdown(uuid) to service_role;

insert into public.schema_migrations (filename) values
  ('0078_reseller_affiliates_pass6.sql')
on conflict do nothing;
