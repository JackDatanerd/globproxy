-- ─────────────────────────────────────────────────────────────────────
-- 0082 · Auth & MFA — independent pass 7
--
--  1. In-place authenticator change ("Change authenticator" in Settings).
--     Before this, moving to a new phone meant disabling 2FA and enrolling again,
--     which leaves the account unprotected in between and fires a "2FA disabled"
--     alert for a routine action. The NEW seed is parked next to the live one
--     (pending_secret) and only replaces it once a code from the new authenticator
--     has been proven, in one statement:
--       mfa_rekey_start(user, secret)                  — park a pending seed (confirmed factors only)
--       mfa_rekey_confirm(user, counter, max_age)      — swap it in, clear failures / lock
--     The live secret, the backup codes and the attempt budget are untouched until
--     the swap, so an abandoned change costs nothing.
--     The two columns are read ONLY by the rekey code paths (lib/mfa.ts getFactor
--     does not select them), so an app deployed before this migration keeps every
--     other 2FA flow working.
--
--  2. Completing an e-mail change now ends every login session and every
--     2FA-verified browser of that account (on_auth_email_changed). Changing the
--     sign-in address is the account-takeover step; password change already did
--     this, e-mail change did not. The session that confirms the change is created
--     AFTER this fires (GoTrue issues it at the code exchange), so the person who
--     just did it stays signed in on the browser that completed it.
--
-- Idempotent. Apply BEFORE / WITH the deploy (the rekey routes answer
-- "temporarily unavailable" until the functions exist).
-- ─────────────────────────────────────────────────────────────────────

alter table public.mfa_totp_factors
  add column if not exists pending_secret text,
  add column if not exists pending_created_at timestamptz;

create or replace function public.mfa_rekey_start(p_user_id uuid, p_secret text)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.mfa_totp_factors
     set pending_secret = p_secret,
         pending_created_at = now()
   where user_id = p_user_id and confirmed;
  return found;
end;
$$;

create or replace function public.mfa_rekey_confirm(p_user_id uuid, p_counter bigint, p_max_age interval)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.mfa_totp_factors
     set secret = pending_secret,
         last_used_counter = p_counter,
         last_used_at = now(),
         failed_attempts = 0,
         locked_until = null,
         pending_secret = null,
         pending_created_at = null
   where user_id = p_user_id
     and confirmed
     and pending_secret is not null
     and pending_created_at > now() - p_max_age;
  return found;
end;
$$;

revoke all on function public.mfa_rekey_start(uuid, text) from public, anon, authenticated;
revoke all on function public.mfa_rekey_confirm(uuid, bigint, interval) from public, anon, authenticated;
grant execute on function public.mfa_rekey_start(uuid, text) to service_role;
grant execute on function public.mfa_rekey_confirm(uuid, bigint, interval) to service_role;

-- ── 2. e-mail change ends every session ──────────────────────────────
create or replace function public.on_auth_email_changed()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.email is distinct from old.email
     and old.email is not null
     and old.email_confirmed_at is not null then
    insert into public.security_events (user_id, event, notify, meta)
    select new.id, 'email_changed', true,
           jsonb_build_object(
             'old_email', old.email,
             'new_email_masked', left(split_part(new.email, '@', 1), 1) || '***@' || split_part(new.email, '@', 2)
           )
    where exists (select 1 from public.profiles where id = new.id);

    delete from auth.sessions where user_id = new.id;
    delete from public.mfa_verified_sessions where user_id = new.id;
  end if;
  return new;
end;
$$;

insert into public.schema_migrations (filename) values
  ('0082_auth_mfa_pass7.sql')
on conflict do nothing;
