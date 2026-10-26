-- ─────────────────────────────────────────────────────────────────────
-- 0090 · Auth & MFA — independent pass 8
--
--  1. Payout hold: 'mfa_rekeyed' (authenticator replaced) now bumps the hold like
--     'mfa_backup_regenerated' does — both need a valid current code, and both are
--     steps someone who has taken the account would make.
--  2. E-mail policy on CHANGE, not only on sign-up. enforce_signup_policy (ban list +
--     disposable domains) only fires BEFORE INSERT on auth.users, so a signed-in user
--     calling the auth API directly could move to a banned or disposable address.
--     GoTrue parks the requested address in auth.users.email_change when the change is
--     STARTED, so it is checked there (before both confirmation links go out), not at
--     the final confirmation. A pending address that already passes is untouched.
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────

create or replace function public.bump_payout_hold_on_security_event()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.event in ('password_changed', 'email_change_requested', 'mfa_disabled',
                   'mfa_reset_by_admin', 'mfa_backup_regenerated', 'mfa_rekeyed',
                   'email_changed', 'mfa_recovery_completed') then
    update public.profiles
    set payout_method_updated_at = now(),
        payout_hold_reason = 'security_event'
    where id = new.user_id and payout_method is not null;
  end if;
  return new;
end;
$$;
revoke all on function public.bump_payout_hold_on_security_event() from public, anon, authenticated;

create or replace function public.enforce_email_change_policy()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_domain text;
begin
  if new.email_change is null or new.email_change = '' then return new; end if;
  if new.email_change is not distinct from old.email_change then return new; end if;
  v_domain := lower(split_part(new.email_change, '@', 2));

  if public.is_email_banned(new.email_change) then
    raise exception 'This email address cannot be used.' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.disposable_email_domains d
    where v_domain = d.domain or v_domain like '%.' || d.domain
  ) then
    raise exception 'Disposable email addresses are not allowed.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_email_change_policy() from public, anon, authenticated;

drop trigger if exists enforce_email_change_policy on auth.users;
create trigger enforce_email_change_policy
  before update of email_change on auth.users
  for each row execute procedure public.enforce_email_change_policy();

insert into public.schema_migrations (filename) values
  ('0090_auth_mfa_pass8.sql')
on conflict do nothing;
