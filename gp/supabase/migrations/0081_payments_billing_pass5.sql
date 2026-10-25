-- ============================================================
-- 0081 — Payments & billing close-out (audit section 3, round 5)
-- ============================================================
-- 1. auto_recharge_due(): the recharge cron used to read the 500 oldest-attempted
--    rules and test balances in the app, so once more than 500 rules were enabled
--    the ones that were actually below their threshold could starve behind rules
--    that never need a top-up (their last_attempt_at never moves). The threshold /
--    cooldown test now happens in SQL, so the cron only ever sees rules that are due.
-- 2. saved_cards.expiry_warned_at + auto_recharge_expiring(): a customer is told once,
--    before the saved card lapses, instead of finding out after three failed charges.
--    Saving a new card clears the mark (app code).
--
-- Run this BEFORE deploying the matching app code (the recharge cron calls both
-- functions).

alter table public.saved_cards add column if not exists expiry_warned_at timestamptz;

-- ── 1. rules that are due now ───────────────────────────────
-- Enabled, balance below threshold, cooldown elapsed. Rules never attempted come
-- first, then the longest-waiting. A rule with no balance row (nothing bought yet)
-- is not due: auto-recharge tops up, it does not first-buy.
create or replace function public.auto_recharge_due(p_cooldown_seconds integer, p_limit integer)
returns setof jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select to_jsonb(r) || jsonb_build_object('available_gb', b.available_gb)
  from public.auto_recharge r
  join public.bandwidth_accounts b on b.user_id = r.user_id
  where r.enabled
    and b.available_gb < r.threshold_gb
    and (r.last_attempt_at is null or r.last_attempt_at <= now() - make_interval(secs => greatest(p_cooldown_seconds, 0)))
  order by r.last_attempt_at asc nulls first
  limit greatest(least(p_limit, 500), 1);
$$;
revoke all on function public.auto_recharge_due(integer, integer) from public, anon, authenticated;
grant execute on function public.auto_recharge_due(integer, integer) to service_role;

-- ── 2. saved cards that are about to lapse (or have) ────────
-- Paystack sends exp_month "12" and exp_year "2030"; a two-digit year is read as 20xx.
-- Anything that does not parse is ignored rather than raising.
create or replace function public.auto_recharge_expiring(p_days integer, p_limit integer)
returns table (user_id uuid, valid_until timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with parsed as (
    select c.user_id, c.expiry_warned_at,
      case
        when c.exp_month ~ '^(0?[1-9]|1[0-2])$' and c.exp_year ~ '^([0-9]{2}|[0-9]{4})$' and c.exp_year <> '0000'
        then (make_date(case when length(c.exp_year) = 2 then 2000 + c.exp_year::int else c.exp_year::int end,
                        c.exp_month::int, 1) + interval '1 month')::timestamptz
      end as valid_until
    from public.saved_cards c
    join public.auto_recharge r on r.user_id = c.user_id and r.enabled
  )
  select p.user_id, p.valid_until
  from parsed p
  where p.expiry_warned_at is null
    and p.valid_until is not null
    and p.valid_until <= now() + make_interval(days => greatest(p_days, 0))
  order by p.valid_until asc
  limit greatest(least(p_limit, 200), 1);
$$;
revoke all on function public.auto_recharge_expiring(integer, integer) from public, anon, authenticated;
grant execute on function public.auto_recharge_expiring(integer, integer) to service_role;

insert into public.schema_migrations (filename) values
  ('0081_payments_billing_pass5.sql')
on conflict do nothing;
