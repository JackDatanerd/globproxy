-- ─────────────────────────────────────────────────────────────────────
-- 0053 · Auth & MFA — independent pass 3
--
--  1. auth_account_state(): lets signup tell "already has an account" from
--     "closed account" so the address owner gets an explanatory email
--     instead of silence (still never revealed to the person typing it).
--  2. login_sessions: the browser's real IP / user-agent per login session.
--     auth.sessions only records the Worker's, because sign-in happens
--     server-side, so the "Where you're signed in" card showed the wrong
--     device. Keyed by auth.sessions.id (the JWT session_id claim).
--  3. wipe_mfa / confirm_totp_enrollment_atomic cancel any open 2FA
--     recovery request: once 2FA is removed or re-established, an older
--     recovery link must not stay usable.
--  4. mfa_complete_recovery refuses when there is no confirmed factor.
--  5. cleanup_old_security_events() also prunes orphaned login_sessions.
-- ─────────────────────────────────────────────────────────────────────

-- ── 1. account state for signup notices ──────────────────────────────
create or replace function public.auth_account_state(check_email text)
returns text
language plpgsql stable security definer set search_path = public, auth, pg_temp
as $$
declare
  u record;
  p record;
begin
  select id, email_confirmed_at into u
    from auth.users where lower(email) = lower(check_email) limit 1;
  if not found then return 'none'; end if;
  if u.email_confirmed_at is null then return 'unconfirmed'; end if;
  select is_suspended, is_deleted, deleted_at into p from public.profiles where id = u.id;
  if found and (coalesce(p.is_deleted, false) or p.deleted_at is not null) then return 'deleted'; end if;
  if found and coalesce(p.is_suspended, false) then return 'suspended'; end if;
  return 'active';
end;
$$;
revoke all on function public.auth_account_state(text) from public, anon, authenticated;
grant execute on function public.auth_account_state(text) to service_role;

-- ── 2. per-login device record ───────────────────────────────────────
create table if not exists public.login_sessions (
  session_id uuid primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  ip         text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists login_sessions_user_idx on public.login_sessions(user_id);
alter table public.login_sessions enable row level security;
-- No policies: service role only.

-- ── 3. recovery requests die with the factor they were for ───────────
create or replace function public.wipe_mfa(p_user_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  delete from public.mfa_totp_factors where user_id = p_user_id;
  delete from public.mfa_backup_codes where user_id = p_user_id;
  delete from public.mfa_verified_sessions where user_id = p_user_id;
  -- Any still-open recovery request is moot now (completed ones keep their
  -- completed_at so the audit trail is intact).
  update public.mfa_recovery_requests
     set cancelled_at = now()
   where user_id = p_user_id and completed_at is null and cancelled_at is null;
  update public.profiles set mfa_enabled = false where id = p_user_id;
end;
$$;
revoke all on function public.wipe_mfa(uuid) from public, anon, authenticated;
grant execute on function public.wipe_mfa(uuid) to service_role;

create or replace function public.confirm_totp_enrollment_atomic(
  p_user_id uuid, p_used_counter integer, p_hashes text[]
)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_confirmed boolean;
begin
  select confirmed into v_confirmed from public.mfa_totp_factors where user_id = p_user_id for update;
  if not found then
    raise exception 'No pending MFA enrollment found for this account.' using errcode = 'P0002';
  end if;
  if v_confirmed then
    raise exception 'MFA is already enabled for this account.' using errcode = 'P0001';
  end if;

  update public.mfa_totp_factors
    set confirmed = true, confirmed_at = now(), failed_attempts = 0, locked_until = null,
        last_used_at = now(), last_used_counter = p_used_counter
    where user_id = p_user_id;
  update public.profiles set mfa_enabled = true where id = p_user_id;

  delete from public.mfa_backup_codes where user_id = p_user_id and used_at is null;
  insert into public.mfa_backup_codes (user_id, code_hash)
    select p_user_id, h from unnest(p_hashes) as h;

  -- A recovery link issued for the previous authenticator must not outlive
  -- the new one.
  update public.mfa_recovery_requests
     set cancelled_at = now()
   where user_id = p_user_id and completed_at is null and cancelled_at is null;
end;
$$;
revoke all on function public.confirm_totp_enrollment_atomic(uuid, integer, text[]) from public, anon, authenticated;
grant execute on function public.confirm_totp_enrollment_atomic(uuid, integer, text[]) to service_role;

-- ── 4. completion needs a factor to remove ───────────────────────────
create or replace function public.mfa_complete_recovery(p_request_id uuid, p_user_id uuid, p_window interval)
returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  if not exists (select 1 from public.mfa_totp_factors where user_id = p_user_id and confirmed) then
    return false;
  end if;
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
  perform public.wipe_mfa(p_user_id);
  return true;
end;
$$;
revoke all on function public.mfa_complete_recovery(uuid, uuid, interval) from public, anon, authenticated;
grant execute on function public.mfa_complete_recovery(uuid, uuid, interval) to service_role;

-- ── 5. cleanup ───────────────────────────────────────────────────────
create or replace function public.cleanup_old_security_events()
returns integer language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare v_deleted integer;
begin
  delete from public.security_events where created_at < now() - interval '365 days';
  get diagnostics v_deleted = row_count;
  delete from public.auth_throttle where window_start < now() - interval '1 day';
  delete from public.mfa_recovery_requests where created_at < now() - interval '90 days';
  delete from public.login_sessions ls
   where ls.created_at < now() - interval '1 day'
     and not exists (select 1 from auth.sessions s where s.id = ls.session_id);
  return v_deleted;
end;
$$;
revoke all on function public.cleanup_old_security_events() from public, anon, authenticated;
grant execute on function public.cleanup_old_security_events() to service_role;

insert into public.schema_migrations (filename) values
  ('0053_auth_mfa_pass3.sql')
on conflict do nothing;
