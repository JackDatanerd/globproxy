-- 0050: Auth & MFA — pass 2 close-out.
--
-- 1. proxy_credentials upstream columns are renamed so the supplier's name is
--    not visible to a customer who queries PostgREST (SELECT on their own
--    rows is allowed; the column NAMES are part of the response). Nothing in
--    SQL (functions, policies, views) referenced the old names; the
--    application code in this release uses the new ones. Run this migration,
--    then deploy straight away — requests in between that still use the old
--    names fail until the new build is live.
-- 2. auth_verify_password(): current-password check done in SQL (bcrypt via
--    pgcrypto, the format GoTrue stores) instead of a throwaway GoTrue
--    sign-in. That sign-in broke when Supabase CAPTCHA is on (no token),
--    created and deleted a real session per check, and made every check
--    count against GoTrue's per-IP sign-in limit (all of them come from the
--    server's addresses).
-- 3. auth_replace_unconfirmed_password(): used by signup AFTER the new
--    confirmation e-mail is accepted, and only while the account is still
--    unconfirmed (atomic). Previously the password was replaced first, so a
--    rate-limited re-signup replaced it without invalidating the owner's
--    existing confirmation link (pre-hijack).
-- 4. mfa_complete_recovery(): claim the request and wipe 2FA in ONE
--    transaction, and refuse requests whose ready window has lapsed.

create extension if not exists pgcrypto with schema extensions;

-- ── 1. column rename ──────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'proxy_credentials'
               and column_name = 'geonode_sub_user_id') then
    alter table public.proxy_credentials rename column geonode_sub_user_id to upstream_sub_user_id;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'proxy_credentials'
               and column_name = 'geonode_username') then
    alter table public.proxy_credentials rename column geonode_username to upstream_username;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'proxy_credentials'
               and column_name = 'geonode_password') then
    alter table public.proxy_credentials rename column geonode_password to upstream_password;
  end if;
end $$;

alter index if exists public.proxy_credentials_geonode_sub_user_key
  rename to proxy_credentials_upstream_sub_user_key;

-- ── 2. password check in SQL ──────────────────────────────────────────
create or replace function public.auth_verify_password(p_user_id uuid, p_password text)
returns boolean
language plpgsql security definer set search_path = public, auth, extensions, pg_temp
as $$
declare v_hash text;
begin
  if p_password is null or p_password = '' then return false; end if;
  select encrypted_password into v_hash
    from auth.users
   where id = p_user_id and deleted_at is null;
  if v_hash is null or v_hash = '' then return false; end if;
  return extensions.crypt(p_password, v_hash) = v_hash;
end;
$$;

revoke all on function public.auth_verify_password(uuid, text) from public, anon, authenticated;
grant execute on function public.auth_verify_password(uuid, text) to service_role;

-- ── 3. conditional password replacement for unconfirmed accounts ──────
create or replace function public.auth_replace_unconfirmed_password(p_user_id uuid, p_password text)
returns boolean
language plpgsql security definer set search_path = public, auth, extensions, pg_temp
as $$
begin
  if p_password is null or length(p_password) < 1 then return false; end if;
  update auth.users
     set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
         updated_at = now()
   where id = p_user_id
     and email_confirmed_at is null
     and deleted_at is null;
  return found;
end;
$$;

revoke all on function public.auth_replace_unconfirmed_password(uuid, text) from public, anon, authenticated;
grant execute on function public.auth_replace_unconfirmed_password(uuid, text) to service_role;

-- ── 4. atomic recovery completion ─────────────────────────────────────
create or replace function public.mfa_complete_recovery(p_request_id uuid, p_user_id uuid, p_window interval)
returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  update public.mfa_recovery_requests
     set completed_at = now()
   where id = p_request_id
     and user_id = p_user_id
     and completed_at is null
     and cancelled_at is null
     and confirmed_at is not null
     and ready_at <= now()
     and ready_at + p_window > now()
  returning id into v_id;
  if v_id is null then return false; end if;
  -- Same transaction: if the wipe fails, the claim rolls back with it.
  perform public.wipe_mfa(p_user_id);
  return true;
end;
$$;

revoke all on function public.mfa_complete_recovery(uuid, uuid, interval) from public, anon, authenticated;
grant execute on function public.mfa_complete_recovery(uuid, uuid, interval) to service_role;

-- ── 5. revoke login sessions in bulk ──────────────────────────────────
-- Used after 2FA is removed (self-service recovery keeps the caller's own
-- session; an admin reset ends them all) so anyone else still signed in must
-- sign in again.
create or replace function public.revoke_other_auth_sessions(p_user_id uuid, p_keep uuid)
returns integer
language plpgsql security definer set search_path = public, auth, pg_temp
as $$
declare n integer;
begin
  delete from auth.sessions
   where user_id = p_user_id
     and (p_keep is null or id <> p_keep);
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.revoke_other_auth_sessions(uuid, uuid) from public, anon, authenticated;
grant execute on function public.revoke_other_auth_sessions(uuid, uuid) to service_role;

insert into public.schema_migrations (filename) values
  ('0050_auth_mfa_pass2.sql')
on conflict do nothing;
