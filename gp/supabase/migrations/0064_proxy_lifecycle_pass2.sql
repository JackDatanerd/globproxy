-- 0064_proxy_lifecycle_pass2.sql
-- Proxy lifecycle, independent pass 2 (fix round):
--
--  1. Re-attemptable provisioning: the upstream username/password for a
--     pending credential are decided and PERSISTED before the supplier is
--     called, so a retry after an ambiguous failure (timeout / 5xx after the
--     sub-user was actually created) re-uses the same identity and can adopt the
--     existing sub-user instead of creating a second, orphaned one.
--  2. Live-cap drift escalation: limit_sync_failed_since / limit_sync_alerted_at
--     let the cron tell the customer and the admin when a committed allocation
--     could not be applied to the live proxy for a prolonged time.
--  3. usage_daily + record_usage_deltas(): account-level daily usage kept
--     locally, so usage history covers deleted sessions and accounts with many
--     sessions, and no longer needs a supplier call per session per page load.
--  4. recalculate_bandwidth_accounts(): suspended sessions' consumed GB stay in
--     used_gb (they used to drop out of the sum while suspended).
--  5. Webhook events 'session_updated', 'session_password_rotated',
--     'whitelist_changed' (keep in sync with lib/webhookEvents.ts).
--
-- Keep supabase/schema.sql in sync (scripts/check-schema-sync.mjs).

-- ── 1 + 2. Columns ────────────────────────────────────────────
-- NOT granted to `authenticated` (0059 grants an explicit column list; new
-- columns are fail-closed), so customers cannot read the provisioning identity.
alter table public.proxy_credentials
  add column if not exists provision_username       text,
  add column if not exists provision_password       text,
  add column if not exists limit_sync_failed_since  timestamptz,
  add column if not exists limit_sync_alerted_at    timestamptz;

create unique index if not exists proxy_credentials_provision_username_key
  on public.proxy_credentials (provision_username)
  where provision_username is not null;

-- ── 3. Local daily usage ──────────────────────────────────────
create table if not exists public.usage_daily (
  user_id uuid not null references public.profiles(id) on delete cascade,
  day     date not null,
  gb      numeric not null default 0 check (gb >= 0),
  primary key (user_id, day)
);

alter table public.usage_daily enable row level security;
drop policy if exists "Own daily usage" on public.usage_daily;
create policy "Own daily usage" on public.usage_daily for select using (auth.uid() = user_id);
revoke insert, update, delete on public.usage_daily from anon, authenticated;

-- p_rows: [{ "user_id": uuid, "gb": number }, ...] — GB consumed since the last
-- sync, credited to today's (UTC) bucket. Unknown users are skipped so one
-- deleted profile can never fail a whole batch.
create or replace function public.record_usage_deltas(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  with agg as (
    select (r->>'user_id')::uuid as user_id, sum((r->>'gb')::numeric) as gb
    from jsonb_array_elements(p_rows) r
    where (r->>'gb')::numeric > 0
    group by 1
  ), ins as (
    insert into public.usage_daily (user_id, day, gb)
    select a.user_id, (now() at time zone 'utc')::date, a.gb
    from agg a
    join public.profiles p on p.id = a.user_id
    on conflict (user_id, day) do update set gb = public.usage_daily.gb + excluded.gb
    returning 1
  )
  select count(*) into v_count from ins;
  return coalesce(v_count, 0);
end;
$$;

revoke all on function public.record_usage_deltas(jsonb) from public, anon, authenticated;
grant execute on function public.record_usage_deltas(jsonb) to service_role;

-- ── 4. used_gb keeps suspended sessions ───────────────────────
create or replace function public.recalculate_bandwidth_accounts()
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  update public.bandwidth_accounts ba
  set used_gb = coalesce(sub.total, 0) + ba.archived_used_gb
  from (
    select user_id, sum(gb_used) as total
    from public.proxy_credentials
    where status in ('active', 'suspended')
    group by user_id
  ) sub
  where ba.user_id = sub.user_id;

  update public.bandwidth_accounts ba
  set used_gb = archived_used_gb
  where used_gb <> archived_used_gb
    and not exists (
      select 1 from public.proxy_credentials pc
      where pc.user_id = ba.user_id and pc.status in ('active', 'suspended')
    );
end;
$$;

revoke all on function public.recalculate_bandwidth_accounts() from public, anon, authenticated;
grant execute on function public.recalculate_bandwidth_accounts() to service_role;

-- ── 5. Webhook events ─────────────────────────────────────────
-- COMPLETE list as of 0062 (0059's + bandwidth_debited) plus the three new ones.
alter table public.webhook_endpoints drop constraint if exists webhook_endpoints_valid_events;
alter table public.webhook_endpoints
  add constraint webhook_endpoints_valid_events
  check (event_types <@ array[
    'session_created', 'session_activated', 'session_deleted', 'session_topped_up',
    'session_released', 'session_low', 'session_exhausted',
    'session_suspended', 'session_resumed',
    'session_updated', 'session_password_rotated', 'whitelist_changed',
    'auto_topup_triggered', 'auto_topup_failed',
    'bandwidth_threshold_crossed', 'bandwidth_exhausted', 'bandwidth_credited', 'bandwidth_debited',
    'bandwidth_allocated', 'bandwidth_reclaimed', 'bandwidth_refunded',
    'api_key_created', 'api_key_revoked', 'api_key_expiring'
  ]::text[]);

insert into public.schema_migrations (filename) values
  ('0064_proxy_lifecycle_pass2.sql')
on conflict do nothing;
