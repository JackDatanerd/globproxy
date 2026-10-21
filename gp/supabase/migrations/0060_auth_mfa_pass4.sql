-- ─────────────────────────────────────────────────────────────────────
-- 0060 · Auth & MFA — independent pass 4
--
--  1. Unconfirmed-signup password quarantine (post-hijack fix).
--     The password on an account that has not confirmed its e-mail was chosen
--     by whoever last submitted the signup form for that address — not
--     necessarily the owner (an attacker can re-submit the victim's address
--     with a password they know and wait for the victim to click the link).
--     So when an account becomes confirmed, its password is set aside and
--     replaced with an unguessable one. /auth/callback hands the real password
--     back ONLY when the confirmation link was completed in the same browser
--     that requested it (PKCE code exchange — it needs the verifier cookie AND
--     the e-mailed code). A link opened anywhere else still confirms the
--     address, but the account then needs "Forgot password" before the first
--     password sign-in, which replaces whatever the other party chose.
--  2. on_auth_password_changed ignores the confirmation transition and the
--     restore, and clears any quarantined password when a real change happens.
--  3. profiles.mfa_enabled is kept in step with mfa_totp_factors by a trigger
--     (middleware and layouts read the profile flag, the API reads the factor
--     table — two sources that could disagree).
-- ─────────────────────────────────────────────────────────────────────

-- ── 1. quarantine ────────────────────────────────────────────────────
create table if not exists public.auth_pending_password (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  hash       text not null,
  created_at timestamptz not null default now()
);
alter table public.auth_pending_password enable row level security;
-- No policies: service role / SECURITY DEFINER functions only.

create or replace function public.auth_hold_unconfirmed_password()
returns trigger
language plpgsql security definer set search_path = public, auth, extensions, pg_temp
as $$
begin
  if old.email_confirmed_at is null
     and new.email_confirmed_at is not null
     and coalesce(old.encrypted_password, '') <> '' then
    insert into public.auth_pending_password (user_id, hash, created_at)
    values (new.id, old.encrypted_password, now())
    on conflict (user_id) do update set hash = excluded.hash, created_at = excluded.created_at;
    new.encrypted_password := extensions.crypt(
      gen_random_uuid()::text || gen_random_uuid()::text, extensions.gen_salt('bf', 10));
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_hold_password on auth.users;
create trigger on_auth_user_hold_password
  before update of email_confirmed_at on auth.users
  for each row execute procedure public.auth_hold_unconfirmed_password();

-- Called by /auth/callback after a successful same-browser code exchange.
-- Only honoured shortly after confirmation, and only while the quarantined
-- password has not been superseded by a real password change.
create or replace function public.auth_restore_pending_password(p_user_id uuid)
returns boolean
language plpgsql security definer set search_path = public, auth, pg_temp
as $$
declare
  v_hash text;
begin
  select hash into v_hash
    from public.auth_pending_password
   where user_id = p_user_id and created_at > now() - interval '30 minutes'
   for update;
  if not found then
    delete from public.auth_pending_password where user_id = p_user_id;
    return false;
  end if;

  perform set_config('gp.restoring_pw', '1', true);
  update auth.users
     set encrypted_password = v_hash, updated_at = now()
   where id = p_user_id and email_confirmed_at is not null and deleted_at is null;
  delete from public.auth_pending_password where user_id = p_user_id;
  perform set_config('gp.restoring_pw', '', true);
  return true;
end;
$$;

revoke all on function public.auth_restore_pending_password(uuid) from public, anon, authenticated;
grant execute on function public.auth_restore_pending_password(uuid) to service_role;
revoke all on function public.auth_hold_unconfirmed_password() from public, anon, authenticated;

-- ── 2. password-change trigger ───────────────────────────────────────
create or replace function public.on_auth_password_changed()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.encrypted_password is distinct from old.encrypted_password
     and old.encrypted_password is not null
     and old.email_confirmed_at is not null
     and new.email_confirmed_at is not null
     and coalesce(current_setting('gp.restoring_pw', true), '') <> '1' then
    -- A real change supersedes any quarantined signup password.
    delete from public.auth_pending_password where user_id = new.id;
    delete from public.mfa_verified_sessions where user_id = new.id;
    insert into public.security_events (user_id, event, notify, meta)
    select new.id, 'password_changed', true, jsonb_build_object('source', 'db_trigger')
    where exists (select 1 from public.profiles where id = new.id);
  end if;
  return new;
end;
$$;

-- ── 3. profiles.mfa_enabled follows the factor table ─────────────────
create or replace function public.sync_profile_mfa_enabled()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := coalesce(new.user_id, old.user_id);
  v_on  boolean;
begin
  select exists (select 1 from public.mfa_totp_factors where user_id = v_uid and confirmed) into v_on;
  update public.profiles set mfa_enabled = v_on where id = v_uid and mfa_enabled is distinct from v_on;
  return null;
end;
$$;
revoke all on function public.sync_profile_mfa_enabled() from public, anon, authenticated;

drop trigger if exists mfa_factors_sync_profile on public.mfa_totp_factors;
create trigger mfa_factors_sync_profile
  after insert or update of confirmed or delete on public.mfa_totp_factors
  for each row execute procedure public.sync_profile_mfa_enabled();

-- One-time repair of any drift that already exists.
update public.profiles p
   set mfa_enabled = exists (select 1 from public.mfa_totp_factors f where f.user_id = p.id and f.confirmed)
 where p.mfa_enabled is distinct from
       exists (select 1 from public.mfa_totp_factors f where f.user_id = p.id and f.confirmed);

insert into public.schema_migrations (filename) values
  ('0060_auth_mfa_pass4.sql')
on conflict do nothing;
