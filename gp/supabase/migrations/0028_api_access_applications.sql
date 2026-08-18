-- ============================================================
-- 0028 — API access applications
-- ============================================================
-- Resellers previously had no way to signal "I want API access" — the
-- only path in was an admin noticing on their own and toggling
-- api_access from /admin/users. This adds the same pending/approved/
-- rejected application shape reseller_status/reseller_application
-- already has, so a reseller can apply from /dashboard/api-keys the same
-- way a user applies to become a reseller from /dashboard/settings, and
-- admin gets a reviewable queue instead of having to guess who wants it.
--
-- Safe to run against the live DB: idempotent (IF NOT EXISTS / DROP ...
-- IF EXISTS before CREATE).

alter table public.profiles add column if not exists api_access_status text;
alter table public.profiles add column if not exists api_access_application jsonb;

alter table public.profiles drop constraint if exists profiles_api_access_status_check;
alter table public.profiles add constraint profiles_api_access_status_check
  check (api_access_status is null or api_access_status in ('pending', 'approved', 'rejected'));

-- protect_privileged_profile_columns (migration 0003) already resets
-- role/is_suspended/reseller_status/api_access/etc. back to their old
-- value for any non-admin-authenticated write. api_access_status needs
-- the exact same protection reseller_status has — otherwise a reseller
-- could set their own status straight to 'approved' via a raw REST call
-- to PostgREST, same class of hole 0003 closed for reseller_status.
-- api_access_application, like reseller_application before it, is left
-- unprotected: it's informational only, nothing reads it as an
-- authorization signal, and the app's own write path (apply-api-access)
-- always goes through the admin client regardless.
--
-- Full current body copied from supabase/schema.sql (which already
-- reflects every migration through 0027, including 0011's later
-- addition of the `email` line below) plus this migration's one new
-- line for api_access_status — CREATE OR REPLACE FUNCTION replaces the
-- entire body, so starting from the 0003 version alone here would have
-- silently reverted 0011's fix.
create or replace function public.protect_privileged_profile_columns()
returns trigger language plpgsql security definer as $$
declare
  caller_is_admin boolean;
begin
  -- service-role / admin-client calls have no JWT subject — trusted
  if auth.uid() is null then
    return new;
  end if;

  select (role = 'admin') into caller_is_admin
  from public.profiles where id = auth.uid();

  if coalesce(caller_is_admin, false) then
    return new;
  end if;

  -- non-admin acting on any row (including their own): privileged
  -- columns cannot move via this path
  new.role                  := old.role;
  new.is_suspended          := old.is_suspended;
  new.suspended_at          := old.suspended_at;
  new.suspension_reason     := old.suspension_reason;
  new.reseller_status       := old.reseller_status;
  new.api_access            := old.api_access;
  new.api_access_status     := old.api_access_status;
  new.is_deleted            := old.is_deleted;
  new.deleted_at            := old.deleted_at;
  new.email                 := old.email; -- see migration 0011 — the sync trigger is how email changes actually land

  return new;
end;
$$;

insert into public.schema_migrations (filename) values
  ('0028_api_access_applications.sql')
on conflict do nothing;
