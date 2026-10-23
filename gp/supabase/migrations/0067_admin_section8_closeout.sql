-- 0067_admin_section8_closeout.sql
-- Admin & Verified Operators — audit close-out.
--
--  1. admin_audit_log becomes tamper-resistant. The table was "append-only by
--     convention" only: anything holding the service role (every admin route,
--     any leaked key) could rewrite or delete the record of what admins did.
--     A trigger now rejects DELETE, TRUNCATE and any UPDATE — except the one
--     the foreign keys themselves perform (ON DELETE SET NULL nulling admin_id /
--     target_user_id when a profile row is hard-deleted), which changes nothing
--     else on the row.
--  2. admin_affiliate_earnings() takes an optional list of affiliate ids. The
--     no-argument version returned one row per affiliate that has ever earned,
--     which PostgREST silently cut off at 1000 rows — beyond that the admin
--     affiliate pages showed $0 for affiliates it dropped. The pages now ask
--     only for the affiliates they are displaying.
--
-- Safe to run against the live DB: idempotent.

-- ── 1. Audit log is append-only ─────────────────────────────
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
     -- only the FK "set null" action: a reference may go to NULL, never change
     and (new.admin_id        is not distinct from old.admin_id        or new.admin_id        is null)
     and (new.target_user_id  is not distinct from old.target_user_id  or new.target_user_id  is null)
  then
    return new;
  end if;
  raise exception 'admin_audit_log is append-only (% refused)', tg_op using errcode = '42501';
end;
$$;

drop trigger if exists admin_audit_log_no_change on public.admin_audit_log;
create trigger admin_audit_log_no_change
  before update or delete on public.admin_audit_log
  for each row execute function public.admin_audit_log_guard();

drop trigger if exists admin_audit_log_no_truncate on public.admin_audit_log;
create trigger admin_audit_log_no_truncate
  before truncate on public.admin_audit_log
  for each statement execute function public.admin_audit_log_guard();

-- ── 2. Earnings totals for just the affiliates being shown ──
drop function if exists public.admin_affiliate_earnings();

create or replace function public.admin_affiliate_earnings(p_referrer_ids uuid[] default null)
returns table (referrer_id uuid, accruing_usd numeric, awaiting_usd numeric, paid_usd numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  select
    ac.referrer_id,
    coalesce(sum(ac.commission_amount_usd) filter (where ac.status = 'pending' and ac.payout_id is null), 0),
    coalesce(sum(ac.commission_amount_usd) filter (where ac.status = 'pending' and ac.payout_id is not null), 0),
    coalesce(sum(ac.commission_amount_usd) filter (where ac.status = 'paid'), 0)
  from public.affiliate_commissions ac
  where p_referrer_ids is null or ac.referrer_id = any(p_referrer_ids)
  group by ac.referrer_id;
$$;

revoke all on function public.admin_affiliate_earnings(uuid[]) from public, anon, authenticated;
grant execute on function public.admin_affiliate_earnings(uuid[]) to service_role;

insert into public.schema_migrations (filename) values
  ('0067_admin_section8_closeout.sql')
on conflict do nothing;
