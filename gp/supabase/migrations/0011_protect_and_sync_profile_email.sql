-- ============================================================
-- 0011 — profiles.email: sync it, protect it
-- Safe to run against the live DB: every statement is idempotent
-- (CREATE OR REPLACE / DROP ... IF EXISTS before CREATE / IF NOT EXISTS),
-- so this whole file can be re-run top to bottom even if part of it
-- already applied.
-- ============================================================

-- ── 1. Nothing kept profiles.email in sync with the real login email ──
-- handle_new_user() only ever ran on INSERT into auth.users. When a user
-- later changes their email through Supabase's normal email-change flow
-- (app/auth/callback/route.ts already has a `type === 'email_change'`
-- branch for this), auth.users.email updates but profiles.email was never
-- told — every place that reads profiles.email (admin panels, the
-- confirmation emails in lib/bandwidth.ts, reseller/allocate's recipient
-- lookup, the signup/reset dedupe checks) kept showing/using the old
-- address indefinitely.
create or replace function public.sync_profile_email()
returns trigger language plpgsql security definer as $$
begin
  if new.email is distinct from old.email then
    update public.profiles set email = new.email, updated_at = now() where id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_updated on auth.users;
create trigger on_auth_user_email_updated
  after update of email on auth.users
  for each row execute procedure public.sync_profile_email();

-- ── 2. profiles.email was the one column protect_privileged_profile_ ──
-- columns() forgot. "Update own profile" has no column restriction of its
-- own, so any logged-in user could PATCH their own profiles row directly
-- via the REST API and set email to literally anything — including
-- another real user's address — with nothing stopping it. The app's own
-- UI never does this (dashboard/settings only ever sends full_name/
-- company_name), so this was only reachable by going around the UI, but
-- the DB should be the one enforcing this, not app code's good behavior.
-- Pinning it here the same way every other identity-relevant column
-- already is.
--
-- The sync trigger above still works after this: it runs off an UPDATE on
-- auth.users made by the Supabase Auth service, which has no request JWT
-- attached, so auth.uid() is null in that trigger's execution — the same
-- "service-role / no session" bypass this function already uses for
-- webhook/cron/admin-client writes.
create or replace function public.protect_privileged_profile_columns()
returns trigger language plpgsql security definer as $$
declare
  caller_is_admin boolean;
begin
  if auth.uid() is null then
    return new; -- service-role client / triggers acting on auth.users; app code already gates this
  end if;

  select (role = 'admin') into caller_is_admin
  from public.profiles where id = auth.uid();

  if coalesce(caller_is_admin, false) then
    return new;
  end if;

  new.role                  := old.role;
  new.is_suspended          := old.is_suspended;
  new.suspended_at          := old.suspended_at;
  new.suspension_reason     := old.suspension_reason;
  new.reseller_status       := old.reseller_status;
  new.api_access            := old.api_access;
  new.is_deleted             := old.is_deleted;
  new.deleted_at            := old.deleted_at;
  new.email                 := old.email;

  return new;
end;
$$;

drop trigger if exists protect_privileged_profile_columns on public.profiles;
create trigger protect_privileged_profile_columns
  before update on public.profiles
  for each row execute procedure public.protect_privileged_profile_columns();

-- ── 3. One-time backfill ────────────────────────────────────────────
-- Catches any drift that already happened before this migration ran
-- (a real email change made before trigger #1 existed). Harmless no-op
-- if profiles.email already matches everywhere.
update public.profiles p
set email = u.email
from auth.users u
where p.id = u.id
  and p.email is distinct from u.email
  and u.email is not null;

-- ── 4. Unique constraint ─────────────────────────────────────────────
-- profiles.email never had one. Every lookup in this app that queries
-- profiles by email (auth/signup dedupe, auth/reset, reseller/allocate's
-- recipient lookup) uses .single(), which throws on more than one match —
-- so duplicate emails don't let anyone steal another account, but they do
-- turn those routes into 500s / "recipient not found" failures. Case-
-- insensitive to match how every one of those lookups already queries
-- (.eq('email', x.toLowerCase())).
--
-- PARTIAL index: admin/delete-user and user/delete-account both
-- intentionally anonymise a deleted account's email to the literal string
-- '[deleted]' — by design, every deleted account ends up with that exact
-- same value, which is not a real collision (this was confirmed live: the
-- first attempt at this index failed with
-- `Key (lower(email))=([deleted]) is duplicated`). A plain unique index
-- would reject that legitimate case, or worse, block a second account
-- from ever being deleted once one '[deleted]' row already existed.
-- Excluding that placeholder — rather than excluding on is_deleted, which
-- would leave the placeholder string itself uncovered if that flag were
-- ever out of sync — keeps the constraint scoped to real, live addresses
-- only, which is what every lookup above actually needs uniqueness on.
drop index if exists public.profiles_email_unique_idx;
create unique index profiles_email_unique_idx
  on public.profiles (lower(email))
  where email <> '[deleted]';
