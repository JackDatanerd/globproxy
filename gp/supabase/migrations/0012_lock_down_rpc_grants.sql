-- ============================================================
-- 0012 — Lock down execute grants on security-definer functions
-- ============================================================
-- Every `security definer` function added in 0004/0007/0009/0010
-- (allocate_reseller_bandwidth, credit_bandwidth,
-- reserve_credential_bandwidth, release_credential_bandwidth,
-- bulk_update_credential_usage, recalculate_bandwidth_accounts) runs with
-- the privileges of the function owner and bypasses RLS on the tables it
-- touches — that's the whole point, it's how they get atomicity without
-- going through the RLS-gated REST path. But none of them ever had their
-- EXECUTE privilege restricted. Postgres grants EXECUTE on newly created
-- functions to PUBLIC by default, and Supabase's default project setup
-- (ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon,
-- authenticated, service_role) extends that to the anon/authenticated
-- roles PostgREST actually uses — so, right now, any logged-in user can
-- open the browser console and call these directly via supabase.rpc(),
-- completely bypassing every ownership/role check the application code
-- was relying on:
--
--   - credit_bandwidth(p_user_id, p_gb) — mints free bandwidth into ANY
--     account, no payment required. The most severe of these: a direct,
--     trivial revenue bypass.
--   - allocate_reseller_bandwidth(p_reseller_id, p_recipient_id, p_gb) —
--     never checks the caller actually owns p_reseller_id or is a
--     reseller at all (that check only exists in reseller/allocate/
--     route.ts's application code) — lets any account drain real GB out
--     of any OTHER account into one it controls.
--   - reserve_credential_bandwidth / release_credential_bandwidth — let
--     any user move any other user's allocated_gb up or down directly.
--   - bulk_update_credential_usage(updates) — rewrites gb_used on any
--     credential row by id, no ownership check.
--
-- Two of these (reserve_credential_bandwidth, release_credential_bandwidth)
-- are legitimately called from the user's own browser session (see
-- app/api/dashboard/proxies/route.ts and .../[id]/route.ts, which use
-- createClient() — the anon-key + user-JWT client — not the admin
-- client), so `authenticated` genuinely needs EXECUTE on those two. The
-- fix there is an ownership check inside the function itself (mirrors how
-- RLS would gate a table), not a blanket revoke. The other four
-- (allocate_reseller_bandwidth, credit_bandwidth,
-- bulk_update_credential_usage, recalculate_bandwidth_accounts) are only
-- ever called from server code via createAdminClient() (service_role) —
-- app/api/reseller/allocate, lib/bandwidth.ts, lib/usageSync.ts — so
-- those can be revoked from anon/authenticated entirely.

-- ── 1. Ownership check inside the two functions the browser session
-- legitimately calls directly ──────────────────────────────────────────
create or replace function public.reserve_credential_bandwidth(p_user_id uuid, p_gb numeric)
returns void
language plpgsql
security definer
as $$
declare
  v_updated numeric;
begin
  -- auth.uid() is null for the service-role/admin client (cron, webhook,
  -- activateBandwidth) — trusted, app code already gates those callers.
  -- For anyone else (the authenticated role calling this directly, or via
  -- dashboard/proxies' own session client), the target account must be
  -- their own — same guarantee RLS would give a table, reimplemented here
  -- because this function bypasses RLS by design.
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'Not authorized to reserve bandwidth for another account.' using errcode = '42501';
  end if;

  if p_gb is null or p_gb <= 0 then
    raise exception 'gb_allocated must be greater than 0';
  end if;

  update public.bandwidth_accounts
  set allocated_gb = allocated_gb + p_gb
  where user_id = p_user_id
    and (total_gb - allocated_gb) >= p_gb
  returning allocated_gb into v_updated;

  if v_updated is null then
    raise exception 'Insufficient bandwidth in your account.' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.release_credential_bandwidth(p_user_id uuid, p_gb numeric)
returns void
language plpgsql
security definer
as $$
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'Not authorized to release bandwidth for another account.' using errcode = '42501';
  end if;

  if p_gb is null or p_gb <= 0 then
    return;
  end if;
  update public.bandwidth_accounts
  set allocated_gb = greatest(0, allocated_gb - p_gb)
  where user_id = p_user_id;
end;
$$;

-- ── 2. Revoke, then grant back only what's actually needed ────────────
-- Explicit REVOKE FROM PUBLIC first — this is the step that was missing
-- everywhere. Re-granting to service_role covers the admin-client call
-- sites; authenticated is added only for the two functions above that the
-- browser session genuinely needs, now that they self-check ownership.

revoke all on function public.reserve_credential_bandwidth(uuid, numeric) from public;
grant execute on function public.reserve_credential_bandwidth(uuid, numeric) to authenticated, service_role;

revoke all on function public.release_credential_bandwidth(uuid, numeric) from public;
grant execute on function public.release_credential_bandwidth(uuid, numeric) to authenticated, service_role;

revoke all on function public.credit_bandwidth(uuid, numeric) from public;
grant execute on function public.credit_bandwidth(uuid, numeric) to service_role;

revoke all on function public.allocate_reseller_bandwidth(uuid, uuid, numeric) from public;
grant execute on function public.allocate_reseller_bandwidth(uuid, uuid, numeric) to service_role;

revoke all on function public.bulk_update_credential_usage(jsonb) from public;
grant execute on function public.bulk_update_credential_usage(jsonb) to service_role;

revoke all on function public.recalculate_bandwidth_accounts() from public;
grant execute on function public.recalculate_bandwidth_accounts() to service_role;

-- ── 3. Close the gap for any future function ───────────────────────────
-- Without this, the very next security-definer function someone adds
-- ships with the exact same PUBLIC-executable default that caused this
-- whole issue. New functions now default to service_role-only; anyone
-- who genuinely needs authenticated/anon access has to grant it
-- explicitly and consciously, the same way the two functions above just
-- did.
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public grant execute on functions to service_role;
