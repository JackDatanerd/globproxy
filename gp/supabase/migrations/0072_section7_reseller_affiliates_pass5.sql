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
