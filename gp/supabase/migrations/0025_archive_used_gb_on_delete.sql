-- ============================================================
-- 0025 — Stop used_gb from disappearing when a credential is deleted
-- ============================================================
-- recalculate_bandwidth_accounts() (migration 0009) computes used_gb as a
-- LIVE sum of gb_used across a user's currently-active proxy_credentials
-- rows. That's correct while the credential still exists, but the moment
-- it's deleted the row — and every GB it had recorded as consumed — drops
-- out of that sum entirely. The next cron tick (~5 min) then quietly
-- lowers used_gb by however much that session had used, even though the
-- GB itself is gone for good (allocated_gb only released the *unused*
-- portion back on delete — see the DELETE handler in
-- app/api/dashboard/proxies/[id]/route.ts and its own migration-0009
-- comment). Concretely: 1.00 GB total, use 0.05 GB on a session, delete
-- it — Used drops back toward 0 while Available only grew by the unused
-- 0.95 GB, so 0.05 GB is permanently spent but shows up nowhere on the
-- dashboard. To a customer with no reason to remember exact numbers, that
-- reads as "the math doesn't add up."
--
-- Fix: give bandwidth_accounts a durable ledger for GB that was consumed
-- by credentials that no longer exist, and fold it into used_gb instead of
-- letting used_gb reset to whatever's left in the active set.

alter table public.bandwidth_accounts
  add column if not exists archived_used_gb numeric not null default 0;

-- Bump the archive by exactly what a credential had consumed, at the
-- moment it's deleted — called from the same request that deletes the row
-- and releases its unused allocation, so the two numbers (release + archive)
-- are always derived from the same usedGb snapshot and can't drift apart.
-- service_role-only, same posture as release_credential_bandwidth: the
-- caller (an API route) has already verified the user's own session before
-- ever reaching this.
create or replace function public.archive_credential_used_gb(p_user_id uuid, p_gb numeric)
returns void language plpgsql security definer as $$
begin
  if p_gb is null or p_gb <= 0 then
    return;
  end if;
  update public.bandwidth_accounts
  set archived_used_gb = archived_used_gb + p_gb
  where user_id = p_user_id;
end;
$$;

revoke all on function public.archive_credential_used_gb(uuid, numeric) from public;
grant execute on function public.archive_credential_used_gb(uuid, numeric) to service_role;

-- recalculate_bandwidth_accounts now adds the archive on top of the live
-- active-credential sum, for every account — including ones with zero
-- active credentials right now, which previously got force-reset to 0
-- (see 0009's second UPDATE) regardless of what they'd archived.
create or replace function public.recalculate_bandwidth_accounts()
returns void language plpgsql security definer as $$
begin
  update public.bandwidth_accounts ba
  set used_gb = coalesce(sub.total, 0) + ba.archived_used_gb
  from (
    select user_id, sum(gb_used) as total
    from public.proxy_credentials
    where status = 'active'
    group by user_id
  ) sub
  where ba.user_id = sub.user_id;

  update public.bandwidth_accounts ba
  set used_gb = archived_used_gb
  where used_gb <> archived_used_gb
    and not exists (
      select 1 from public.proxy_credentials pc
      where pc.user_id = ba.user_id and pc.status = 'active'
    );
end;
$$;
