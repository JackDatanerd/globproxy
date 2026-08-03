-- ============================================================
-- 0010 — Bulk usage-sync functions
-- ============================================================
-- Fixes the cron usage-sync 500 crash: runUsageSync() (app/api/cron/[task]
-- /route.ts) was making one Geonode API call per active credential AND one
-- Supabase update per changed credential AND one select+update per user
-- account — all counting against Cloudflare Workers' 50-subrequest-per-
-- invocation cap (Free plan). Once enough credentials existed from testing,
-- a single invocation crossed that cap and the Workers runtime killed the
-- whole invocation with an opaque 500 — below the level JS try/catch can
-- intercept, so the per-credential try/catch in the old code couldn't save
-- it. cron-job.org auto-disabled the job after 26 consecutive failures.
--
-- Fix pairs with listAllSubUsersUsage() in lib/geonode.ts, which replaces
-- N individual Geonode calls with ceil(N/100) paginated list calls. These
-- two functions do the same for the database side: one round trip each
-- instead of one per credential / one per account.
--
-- NOTE: this only touches gb_used (proxy_credentials) and used_gb
-- (bandwidth_accounts) — the real-usage reporting fields. It does not touch
-- allocated_gb or available_gb, which migrations 0007/0009 already made the
-- source of truth for "can a new credential be created." Those are separate
-- concerns and this migration doesn't change that model.

create or replace function bulk_update_credential_usage(updates jsonb)
returns void
language plpgsql
security definer
as $$
begin
  update public.proxy_credentials pc
  set gb_used = (u->>'gb_used')::numeric
  from jsonb_array_elements(updates) as u
  where pc.id = (u->>'id')::uuid;
end;
$$;

create or replace function recalculate_bandwidth_accounts()
returns void
language plpgsql
security definer
as $$
begin
  -- Set used_gb to the real sum of active credentials' usage for every
  -- account that has at least one active credential.
  update public.bandwidth_accounts ba
  set used_gb = coalesce(sub.total, 0)
  from (
    select user_id, sum(gb_used) as total
    from public.proxy_credentials
    where status = 'active'
    group by user_id
  ) sub
  where ba.user_id = sub.user_id;

  -- Zero out accounts with no active credentials at all — the join above
  -- never touches these rows otherwise, leaving stale used_gb behind.
  update public.bandwidth_accounts ba
  set used_gb = 0
  where used_gb <> 0
    and not exists (
      select 1 from public.proxy_credentials pc
      where pc.user_id = ba.user_id and pc.status = 'active'
    );
end;
$$;
