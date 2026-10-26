-- 0073_admin_section8_pass5.sql
-- Admin & Verified Operators — independent pass 5.
--
--  1. admin_locks + claim_admin_lock()/release_admin_lock(): an atomic lock so
--     two full usage syncs can never overlap (the old guard read the audit log,
--     which is only written when a sync FINISHES).
--  2. Ban matching: normalize_ban_email() now also folds Gmail's dot-insensitivity
--     and googlemail.com (a.b@gmail.com = ab@gmail.com), is_email_banned() also
--     honours "@domain" entries, and profiles_matching_ban() finds the existing
--     accounts a ban affects, alias-aware.
--  3. admin_audit_log stays append-only, but a narrow SECURITY DEFINER path
--     (redact_admin_audit_details) may REMOVE named keys from details — so
--     personal data that should never have been logged can be erased. The emails
--     already written by user.delete / reseller_invitation_cancelled are scrubbed.
--  4. support_report_replies: what support wrote back to a customer.
--  5. affiliate_rate_history: the rates in force at each moment, so a commission
--     back-filled later (clear_referral_flag) is paid at the rate that applied
--     WHEN the order was paid, not today's. record_affiliate_commission() uses it.
--  6. verified_operator_reviews + admin_affiliate_performance(): periodic review
--     of Verified Operators and the numbers to decide a grant or a review on.
--  7. admin_reverse_paid_payout(): a payout marked paid whose money never arrived
--     goes back to pending.
--
-- Safe to run against the live DB: idempotent.

-- ── 1. Admin locks ─────────────────────────────────────────
create table if not exists public.admin_locks (
  key          text primary key,
  locked_until timestamptz not null
);
alter table public.admin_locks enable row level security;
revoke all on table public.admin_locks from anon, authenticated;

create or replace function public.claim_admin_lock(p_key text, p_ttl_seconds integer)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_got boolean;
begin
  insert into public.admin_locks (key, locked_until)
  values (p_key, now() + make_interval(secs => greatest(p_ttl_seconds, 1)))
  on conflict (key) do update
    set locked_until = excluded.locked_until
    where public.admin_locks.locked_until <= now()
  returning true into v_got;
  return coalesce(v_got, false);
end;
$$;

create or replace function public.release_admin_lock(p_key text, p_cooldown_seconds integer default 0)
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.admin_locks
     set locked_until = now() + make_interval(secs => greatest(p_cooldown_seconds, 0))
   where key = p_key;
$$;

revoke all on function public.claim_admin_lock(text, integer) from public, anon, authenticated;
revoke all on function public.release_admin_lock(text, integer) from public, anon, authenticated;
grant execute on function public.claim_admin_lock(text, integer) to service_role;
grant execute on function public.release_admin_lock(text, integer) to service_role;

-- ── 2. Ban matching ────────────────────────────────────────
create or replace function public.normalize_ban_email(p text)
returns text language sql immutable as $$
  select case
    when lower(split_part(trim(p), '@', 2)) in ('gmail.com', 'googlemail.com')
      then replace(regexp_replace(lower(split_part(trim(p), '@', 1)), '\+.*$', ''), '.', '') || '@gmail.com'
    else regexp_replace(lower(split_part(trim(p), '@', 1)), '\+.*$', '') || '@' || lower(split_part(trim(p), '@', 2))
  end;
$$;

-- The expression index was built with the old definition.
reindex index public.banned_emails_normalized_idx;

create or replace function public.is_email_banned(check_email text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.banned_emails b
    where public.normalize_ban_email(b.email) = public.normalize_ban_email(check_email)
       or (left(b.email, 1) = '@' and lower(b.email) = '@' || lower(split_part(trim(check_email), '@', 2)))
  );
$$;

create or replace function public.profiles_matching_ban(p_email text)
returns table (id uuid, email text, full_name text, role text, is_suspended boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select p.id, p.email, p.full_name, p.role, coalesce(p.is_suspended, false)
  from public.profiles p
  where coalesce(p.is_deleted, false) = false
    and p.email is not null and p.email <> '[deleted]'
    and case
          when left(trim(p_email), 1) = '@'
            then lower(split_part(p.email, '@', 2)) = lower(substr(trim(p_email), 2))
          else public.normalize_ban_email(p.email) = public.normalize_ban_email(p_email)
        end
  order by p.created_at
  limit 200;
$$;

revoke all on function public.profiles_matching_ban(text) from public, anon, authenticated;
grant execute on function public.profiles_matching_ban(text) to service_role;
revoke all on function public.is_email_banned(text) from public, anon, authenticated;
grant execute on function public.is_email_banned(text) to service_role;
revoke all on function public.normalize_ban_email(text) from public, anon, authenticated;
grant execute on function public.normalize_ban_email(text) to service_role;

-- ── 3. Audit log: append-only, with a narrow redaction path ─
create or replace function public.admin_audit_log_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE'
     and new.id         is not distinct from old.id
     and new.action     is not distinct from old.action
     and new.target_ref is not distinct from old.target_ref
     and new.details    is not distinct from old.details
     and new.created_at is not distinct from old.created_at
     and (new.admin_id        is not distinct from old.admin_id        or new.admin_id        is null)
     and (new.target_user_id  is not distinct from old.target_user_id  or new.target_user_id  is null)
  then
    return new;
  end if;
  -- Redaction: ONLY removing keys from details, ONLY via redact_admin_audit_details().
  if tg_op = 'UPDATE'
     and coalesce(current_setting('app.admin_audit_redaction', true), '') = 'on'
     and new.id         is not distinct from old.id
     and new.action     is not distinct from old.action
     and new.target_ref is not distinct from old.target_ref
     and new.created_at is not distinct from old.created_at
     and new.admin_id        is not distinct from old.admin_id
     and new.target_user_id  is not distinct from old.target_user_id
     and old.details @> new.details
  then
    return new;
  end if;
  raise exception 'admin_audit_log is append-only (% refused)', tg_op using errcode = '42501';
end;
$$;

create or replace function public.redact_admin_audit_details(
  p_action text, p_keys text[], p_target_user uuid default null
)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n integer;
begin
  perform set_config('app.admin_audit_redaction', 'on', true);
  update public.admin_audit_log
     set details = details - p_keys
   where action = p_action
     and (p_target_user is null or target_user_id = p_target_user)
     and details ?| p_keys;
  get diagnostics v_n = row_count;
  perform set_config('app.admin_audit_redaction', 'off', true);
  return v_n;
end;
$$;
revoke all on function public.redact_admin_audit_details(text, text[], uuid) from public, anon, authenticated;
grant execute on function public.redact_admin_audit_details(text, text[], uuid) to service_role;

-- One-off: personal data that earlier versions wrote into the log.
select public.redact_admin_audit_details('user.delete', array['email']);
select public.redact_admin_audit_details('reseller_invitation_cancelled', array['recipient_email']);

-- ── 4. What support told the customer ──────────────────────
create table if not exists public.support_report_replies (
  id         uuid default uuid_generate_v4() primary key,
  report_id  uuid not null references public.support_reports(id) on delete cascade,
  admin_id   uuid references public.profiles(id) on delete set null,
  message    text not null check (char_length(message) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists idx_support_report_replies_report on public.support_report_replies(report_id, created_at);
alter table public.support_report_replies enable row level security;
revoke all on table public.support_report_replies from anon, authenticated;

-- ── 5. Affiliate rate history ──────────────────────────────
create table if not exists public.affiliate_rate_history (
  id             uuid default uuid_generate_v4() primary key,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  intro_rate     numeric not null,
  lifetime_rate  numeric not null,
  effective_from timestamptz not null default now(),
  source         text
);
create index if not exists idx_affiliate_rate_history_user on public.affiliate_rate_history(user_id, effective_from desc);
alter table public.affiliate_rate_history enable row level security;
revoke all on table public.affiliate_rate_history from anon, authenticated;

insert into public.affiliate_rate_history (user_id, intro_rate, lifetime_rate, effective_from, source)
select p.id, coalesce(p.affiliate_commission_rate, 0.30), coalesce(p.affiliate_commission_rate_lifetime, 0.15), 'epoch', 'seed'
from public.profiles p
where p.affiliate_status in ('approved', 'suspended')
  and not exists (select 1 from public.affiliate_rate_history h where h.user_id = p.id);

create or replace function public.record_affiliate_rate_change()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.affiliate_commission_rate is null and new.affiliate_commission_rate_lifetime is null then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.affiliate_commission_rate          is not distinct from old.affiliate_commission_rate
     and new.affiliate_commission_rate_lifetime is not distinct from old.affiliate_commission_rate_lifetime then
    return new;
  end if;
  insert into public.affiliate_rate_history (user_id, intro_rate, lifetime_rate, source)
  values (new.id, coalesce(new.affiliate_commission_rate, 0.30), coalesce(new.affiliate_commission_rate_lifetime, 0.15), tg_op);
  return new;
end;
$$;

drop trigger if exists trg_record_affiliate_rate_change on public.profiles;
create trigger trg_record_affiliate_rate_change
  after insert or update of affiliate_commission_rate, affiliate_commission_rate_lifetime on public.profiles
  for each row execute function public.record_affiliate_rate_change();

-- The rate level now comes from the history row in force at the earn time (falling
-- back to the earliest row, then to the profile) — a late back-fill pays what was
-- promised when the order was paid. Everything else is unchanged from 0051.
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
  v_h_intro numeric;
  v_h_life numeric;
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

  select h.intro_rate, h.lifetime_rate into v_h_intro, v_h_life
  from public.affiliate_rate_history h
  where h.user_id = v_referrer_id and h.effective_from <= coalesce(p_earned_at, now())
  order by h.effective_from desc limit 1;
  if not found then
    select h.intro_rate, h.lifetime_rate into v_h_intro, v_h_life
    from public.affiliate_rate_history h
    where h.user_id = v_referrer_id order by h.effective_from asc limit 1;
  end if;
  v_intro_rate := coalesce(v_h_intro, v_intro_rate);
  v_lifetime_rate := coalesce(v_h_life, v_lifetime_rate);

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

-- ── 6. Verified Operator review + performance ──────────────
create table if not exists public.verified_operator_reviews (
  id          uuid default uuid_generate_v4() primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  reviewed_by uuid references public.profiles(id) on delete set null,
  note        text not null,
  reviewed_at timestamptz not null default now()
);
create index if not exists idx_vo_reviews_user on public.verified_operator_reviews(user_id, reviewed_at desc);
alter table public.verified_operator_reviews enable row level security;
revoke all on table public.verified_operator_reviews from anon, authenticated;

create or replace function public.admin_affiliate_performance(p_referrer_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'referrals_total',     (select count(*) from public.referrals where referrer_id = p_referrer_id),
    'referrals_flagged',   (select count(*) from public.referrals where referrer_id = p_referrer_id and flagged),
    'referrals_converted', (select count(distinct referral_id) from public.affiliate_commissions where referrer_id = p_referrer_id and status <> 'void'),
    'gross_90d_usd',       coalesce((select sum(gross_amount_usd) from public.affiliate_commissions
                              where referrer_id = p_referrer_id and status <> 'void' and voided_at is null
                                and created_at >= now() - interval '90 days'), 0),
    'commission_90d_usd',  coalesce((select sum(commission_amount_usd) from public.affiliate_commissions
                              where referrer_id = p_referrer_id and status <> 'void' and voided_at is null
                                and created_at >= now() - interval '90 days'), 0),
    'commissions_voided',  (select count(*) from public.affiliate_commissions where referrer_id = p_referrer_id and (status = 'void' or voided_at is not null)),
    'open_deductions_usd', coalesce((select sum(amount_usd) from public.affiliate_adjustments
                              where referrer_id = p_referrer_id and payout_id is null and waived_at is null), 0)
  );
$$;
revoke all on function public.admin_affiliate_performance(uuid) from public, anon, authenticated;
grant execute on function public.admin_affiliate_performance(uuid) to service_role;

-- ── 7. Reverse a payout marked paid by mistake ─────────────
create or replace function public.admin_reverse_paid_payout(p_payout_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p public.affiliate_payouts%rowtype;
  v_n integer;
begin
  select * into p from public.affiliate_payouts where id = p_payout_id for update;
  if not found or p.status <> 'paid' then
    return null;
  end if;
  -- A commission recovered after payout already produced a deduction; reverting the
  -- payout would count it twice.
  if exists (select 1 from public.affiliate_commissions where payout_id = p.id and voided_at is not null) then
    return jsonb_build_object('blocked', 'voided_commissions');
  end if;

  update public.affiliate_payouts
     set status = 'pending', paid_at = null, paid_by = null, payment_reference = null, notified_at = null
   where id = p.id;
  update public.affiliate_commissions
     set status = 'pending', paid_at = null
   where payout_id = p.id and status = 'paid';
  get diagnostics v_n = row_count;

  return jsonb_build_object(
    'referrer_id', p.referrer_id, 'amount_usd', p.amount_usd,
    'cycle_start', p.cycle_start, 'cycle_end', p.cycle_end,
    'payment_reference', p.payment_reference, 'commissions_reverted', v_n
  );
end;
$$;
revoke all on function public.admin_reverse_paid_payout(uuid) from public, anon, authenticated;
grant execute on function public.admin_reverse_paid_payout(uuid) to service_role;

insert into public.schema_migrations (filename) values
  ('0073_admin_section8_pass5.sql')
on conflict do nothing;
