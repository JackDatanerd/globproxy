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
