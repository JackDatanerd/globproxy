-- ============================================================
-- 0112 — Database layer close-out (independent audit pass, Oct 2026)
-- ============================================================
-- Found by building a database from schema.sql and another from the pre-0001 baseline plus
-- every migration, then diffing the two catalogs (scripts/check-db-parity.mjs does this in CI).
--
--  1. profiles.marketing_emails: 0108 granted SELECT on it to `authenticated`, but the fold of
--     0108 into schema.sql dropped the grant, so a database built from schema.sql could not read
--     the column and the settings toggle showed "on" for customers who had opted out.
--  2. schema_migrations: schema.sql recorded only 72 of the 111 migrations (0001-0038 and 0046
--     were missing), so scripts/check-migrations-applied.mjs failed on a schema.sql database.
--  3. The default-privilege "safety net" from 0012 never worked: a schema-scoped REVOKE cannot
--     remove Postgres' built-in EXECUTE-for-PUBLIC on new functions, so the next function added
--     without its own REVOKE shipped callable by anon through /rpc. Revoked globally here.
--     Two trigger functions and is_admin() were still client-executable; closed.
--  4. profiles was writable by `authenticated` column-by-column except for a denylist trigger
--     (protect_privileged_profile_columns), so created_at, updated_at, the three *_application
--     columns, billing_address, tax_id and every future column were user-writable. The browser
--     only ever writes six columns; UPDATE is now an allowlist of exactly those. The trigger
--     stays as a second layer. INSERT / DELETE / TRUNCATE are not needed by any browser path.
--  5. Constraint names on profiles differed between a schema.sql database and a migrated one
--     (a later "drop constraint <migration name>" would silently do nothing); aligned.
--  6. return_reseller_stock_on_client_delete read each transfer's remaining GB without a lock
--     and took locks in the opposite order from reclaim_reseller_allocation: a concurrent reclaim
--     could be double-counted (stock over-returned to the reseller) or deadlock. It now locks the
--     transfer row first, re-reads it, then the account rows — the same order as the reclaim.
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────

-- 1 ───────────────────────────────────────────────────────────────────
grant select (marketing_emails) on public.profiles to authenticated;

-- 2 ───────────────────────────────────────────────────────────────────
insert into public.schema_migrations (filename) values
  ('0001_proxy_credentials_missing_columns.sql'),
  ('0002_proxy_sessions.sql'),
  ('0003_rls_and_integrity_fixes.sql'),
  ('0004_reseller_allocation_and_race_fixes.sql'),
  ('0005_api_keys.sql'),
  ('0006_lock_down_order_columns.sql'),
  ('0007_reserve_credential_bandwidth.sql'),
  ('0008_drop_dead_reserve_reseller_gb.sql'),
  ('0009_fix_available_gb_double_count.sql'),
  ('0010_bulk_usage_sync_functions.sql'),
  ('0011_protect_and_sync_profile_email.sql'),
  ('0012_lock_down_rpc_grants.sql'),
  ('0013_fix_host_default_brand_leak.sql'),
  ('0014_reseller_client_profile_select.sql'),
  ('0015_atomic_claim_and_credit_order.sql'),
  ('0016_topup_credential.sql'),
  ('0017_auto_topup.sql'),
  ('0018_webhook_endpoints.sql'),
  ('0019_default_auto_topup.sql'),
  ('0020_mfa.sql'),
  ('0021_invoice_numbers.sql'),
  ('0022_mfa_totp_replay_protection.sql'),
  ('0023_proxy_sessions_credential_ownership.sql'),
  ('0024_atomic_wipe_mfa.sql'),
  ('0025_archive_used_gb_on_delete.sql'),
  ('0026_atomic_confirm_mfa_enrollment.sql'),
  ('0027_migration_tracking.sql'),
  ('0028_api_access_applications.sql'),
  ('0029_fix_profiles_rls_recursion_and_signup_check.sql'),
  ('0030_audit_hardening.sql'),
  ('0031_referrals_and_affiliates.sql'),
  ('0032_network_benchmarks.sql'),
  ('0033_seed_benchmark_credential_setting.sql'),
  ('0034_affiliate_payout_cycles.sql'),
  ('0035_mpesa_payout_method.sql'),
  ('0036_payment_alerting_canary_support.sql'),
  ('0037_verified_operators.sql'),
  ('0038_payments_recovery_refunds.sql'),
  ('0046_proxy_lifecycle_residuals.sql')
on conflict (filename) do nothing;

-- 3 ───────────────────────────────────────────────────────────────────
-- Global (not IN SCHEMA): only a global default can remove the PUBLIC EXECUTE that Postgres
-- gives every new function. The schema-level service_role grant from 0012 stays in force.
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;

revoke all on function public.admin_audit_log_guard()      from public, anon, authenticated;
revoke all on function public.record_affiliate_rate_change() from public, anon, authenticated;
-- No policy, default or invoker-rights function uses it any more (the policies that did were
-- replaced by service-role routes); the protect trigger runs it as the owner.
revoke all on function public.is_admin(uuid) from public, anon, authenticated;
grant execute on function public.is_admin(uuid) to service_role;

-- 4 ───────────────────────────────────────────────────────────────────
revoke insert, update, delete, truncate on public.profiles from anon, authenticated;
grant update (full_name, company_name, low_bandwidth_emails, marketing_emails,
              usage_warn_pct, usage_urgent_pct)
  on public.profiles to authenticated;

-- 5 ───────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_constraint where conrelid = 'public.profiles'::regclass
             and conname = 'profiles_affiliate_commission_rate_check')
     and not exists (select 1 from pg_constraint where conrelid = 'public.profiles'::regclass
                     and conname = 'profiles_affiliate_rate_range') then
    alter table public.profiles rename constraint profiles_affiliate_commission_rate_check to profiles_affiliate_rate_range;
  end if;
  if exists (select 1 from pg_constraint where conrelid = 'public.profiles'::regclass
             and conname = 'profiles_affiliate_commission_rate_lifetime_check')
     and not exists (select 1 from pg_constraint where conrelid = 'public.profiles'::regclass
                     and conname = 'profiles_affiliate_rate_lifetime_range') then
    alter table public.profiles rename constraint profiles_affiliate_commission_rate_lifetime_check to profiles_affiliate_rate_lifetime_range;
  end if;
  if exists (select 1 from pg_constraint where conrelid = 'public.profiles'::regclass
             and conname = 'profiles_referral_code_key')
     and not exists (select 1 from pg_constraint where conrelid = 'public.profiles'::regclass
                     and conname = 'profiles_referral_code_unique') then
    alter table public.profiles rename constraint profiles_referral_code_key to profiles_referral_code_unique;
  end if;
end $$;

-- 6 ───────────────────────────────────────────────────────────────────
create or replace function public.return_reseller_stock_on_client_delete(p_client uuid)
returns numeric language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c       record;
  t       public.reseller_transfers%rowtype;
  v_rem   numeric;
  v_avail numeric;
  v_amt   numeric;
  v_total numeric := 0;
begin
  for c in
    select id
    from public.reseller_transfers
    where recipient_id = p_client and status = 'active' and gb_amount - reclaimed_gb > 0
    order by created_at desc, id desc
  loop
    -- Same lock order as reclaim_reseller_allocation: the transfer row first (re-read under the
    -- lock, so a reclaim that landed since the list above was taken is seen), then the accounts.
    select * into t from public.reseller_transfers where id = c.id for update;
    if not found or t.status <> 'active' then continue; end if;
    v_rem := t.gb_amount - t.reclaimed_gb;
    if v_rem <= 0 then continue; end if;
    perform 1 from public.bandwidth_accounts where user_id in (t.reseller_id, p_client) order by user_id for update;
    select greatest(coalesce(available_gb, 0), 0) into v_avail from public.bandwidth_accounts where user_id = p_client;
    v_amt := round(least(v_rem, coalesce(v_avail, 0)), 3);
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

insert into public.schema_migrations (filename) values
  ('0112_database_layer_closeout.sql')
on conflict do nothing;
