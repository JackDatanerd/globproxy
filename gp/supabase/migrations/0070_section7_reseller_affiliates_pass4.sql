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
