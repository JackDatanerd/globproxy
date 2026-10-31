-- ============================================================
-- 0040 — proxy_credentials lockdown (security fix)
-- ============================================================
-- Any signed-in user could mint unlimited proxy bandwidth:
--
-- 1. release_credential_bandwidth() / reserve_credential_bandwidth() were
--    granted to `authenticated` and only checked auth.uid() = p_user_id.
--    A user could create a credential (reserving N GB, with a real upstream
--    sub-user capped at N GB), then call release_credential_bandwidth
--    directly with their own JWT to hand the reservation back, and create
--    another one. Repeat forever.
-- 2. proxy_credentials had an INSERT policy (and a DELETE policy) with no
--    column limits and no trigger, reachable via PostgREST with the public
--    anon key. A user could insert rows with any gb_allocated /
--    upstream_sub_user_id / gb_used / status, skipping the reservation
--    entirely; the next order's activation then provisioned those rows at
--    upstream with the forged cap, and forged sub-user ids pointed the
--    delete / top-up / whitelist routes at other customers' sub-users.
--
-- Fix: every write to proxy_credentials and to the reservation counters is
-- now server-side only (service_role). Users keep SELECT.
--
--   * reserve/release: service_role only.
--   * INSERT and DELETE policies dropped; INSERT/UPDATE/DELETE table
--     privileges revoked from anon + authenticated (belt and braces — there
--     was never an UPDATE policy).
--   * delete_own_credential(): one transaction that deletes the row,
--     releases the unused reservation and archives the consumed GB, so a
--     failure between those steps can no longer leak or double-spend a
--     reservation.
--   * CHECK constraints so a bad row can't exist even for service-role bugs
--     (NOT VALID: enforced for new/updated rows without failing the
--     migration on any pre-existing bad row — see the audit query below).
--
-- AFTER APPLYING, run this to look for abuse that already happened:
--
--   -- credentials with no matching reservation (allocated_gb below the sum
--   -- of the account's own credential caps):
--   select ba.user_id, ba.total_gb, ba.allocated_gb,
--          coalesce(sum(pc.gb_allocated),0) as sum_credential_caps
--   from public.bandwidth_accounts ba
--   left join public.proxy_credentials pc
--     on pc.user_id = ba.user_id and pc.created_by is null
--   group by ba.user_id, ba.total_gb, ba.allocated_gb
--   having coalesce(sum(pc.gb_allocated),0) > ba.total_gb;
--
--   -- implausible rows:
--   select id, user_id, gb_allocated, gb_used, upstream_sub_user_id
--   from public.proxy_credentials
--   where gb_allocated < 0 or gb_used < 0 or gb_allocated > 100000;
--
--   -- the same upstream sub-user referenced by more than one row:
--   select upstream_sub_user_id, count(*) from public.proxy_credentials
--   where upstream_sub_user_id is not null
--   group by 1 having count(*) > 1;

-- 1. Reservation RPCs: service_role only ------------------------------
revoke all on function public.reserve_credential_bandwidth(uuid, numeric) from public, anon, authenticated;
grant execute on function public.reserve_credential_bandwidth(uuid, numeric) to service_role;

revoke all on function public.release_credential_bandwidth(uuid, numeric) from public, anon, authenticated;
grant execute on function public.release_credential_bandwidth(uuid, numeric) to service_role;

-- 2. proxy_credentials: read-only for end users ------------------------
drop policy if exists "Create own credentials" on public.proxy_credentials;
drop policy if exists "Delete own unassigned credentials" on public.proxy_credentials;

revoke insert, update, delete on public.proxy_credentials from anon, authenticated;

-- A upstream sub-user belongs to exactly one credential row. Partial unique
-- index so the many NULL (pending) rows are unaffected. If this fails, the
-- audit query above found duplicates: resolve those rows first.
create unique index if not exists proxy_credentials_upstream_sub_user_key
  on public.proxy_credentials (upstream_sub_user_id)
  where upstream_sub_user_id is not null;

alter table public.proxy_credentials
  drop constraint if exists proxy_credentials_gb_allocated_sane;
alter table public.proxy_credentials
  add constraint proxy_credentials_gb_allocated_sane
  check (gb_allocated >= 0 and gb_allocated <= 100000) not valid;

alter table public.proxy_credentials
  drop constraint if exists proxy_credentials_gb_used_nonneg;
alter table public.proxy_credentials
  add constraint proxy_credentials_gb_used_nonneg
  check (gb_used is null or gb_used >= 0) not valid;

-- 3. Atomic delete of a self-created credential ------------------------
-- p_live_used_gb is the live upstream figure the route fetched before
-- deleting the sub-user (NULL if that call failed). The larger of it and
-- the last synced gb_used is treated as consumed, so a failed or stale
-- live read can never under-count usage and hand back too much.
create or replace function public.delete_own_credential(
  p_credential_id uuid,
  p_user_id uuid,
  p_live_used_gb numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cred     public.proxy_credentials%rowtype;
  v_used     numeric;
  v_release  numeric;
begin
  select * into v_cred
  from public.proxy_credentials
  where id = p_credential_id
    and user_id = p_user_id
    and created_by is null
  for update;

  if not found then
    raise exception 'Credential not found' using errcode = 'P0002';
  end if;

  v_used    := greatest(coalesce(p_live_used_gb, 0), coalesce(v_cred.gb_used, 0), 0);
  v_release := greatest(0, v_cred.gb_allocated - v_used);

  delete from public.proxy_credentials where id = v_cred.id;

  update public.bandwidth_accounts
  set allocated_gb     = greatest(0, allocated_gb - v_release),
      archived_used_gb = archived_used_gb + v_used
  where user_id = p_user_id;

  return jsonb_build_object('released_gb', v_release, 'archived_gb', v_used);
end;
$$;

revoke all on function public.delete_own_credential(uuid, uuid, numeric) from public, anon, authenticated;
grant execute on function public.delete_own_credential(uuid, uuid, numeric) to service_role;

insert into public.schema_migrations (filename) values
  ('0040_proxy_credentials_lockdown.sql')
on conflict do nothing;
