-- Auth & MFA — independent pass 9.
--
-- 1. security_events is no longer readable from the browser. The "Own security events" RLS
--    policy let ANY signed-in session — including a password-only one on an account that has
--    2FA — list every sign-in IP, browser and country for 365 days straight through the
--    PostgREST API, which made the 2FA gate on /api/auth/sessions pointless (it exists
--    precisely so that session cannot see the owner's devices). With the policy gone the
--    table has RLS enabled and no policy for anon / authenticated: the only reader left is
--    the service-role client, behind GET /api/auth/security-events (2FA-gated).
--
-- 2. profiles: the saved payout destination (wallet address, M-Pesa phone, bank details) was
--    selectable by the owner's own token through "Own profile" — lib/maskPayout.ts promises it
--    is write-only in the browser, but the masking only hid it on screen. Column privileges
--    are the only per-column control Postgres has, so SELECT is now granted column by column,
--    leaving these three out. Everything that needs them already runs as the service role
--    (admin pages, payouts CSV, update-payout-method) or, for /dashboard/referrals, now reads
--    them through the service role and masks them server side.
--    NOTE FOR FUTURE MIGRATIONS: a new profiles column is NOT readable by signed-in users until
--    it is granted:   grant select (new_col) on public.profiles to authenticated;
--    (tests/auth-mfa-pass9.test.mjs fails the build if a migration forgets.)
--
-- 3. enforce_signup_policy / enforce_email_change_policy compared the raw domain with the
--    disposable list, so "x@mailinator.com." (trailing dot) or a domain ending in an invisible
--    character (zero-width space, soft hyphen ...) did not match "mailinator.com". Such
--    addresses are now refused outright. normalize_ban_email() is deliberately left alone: it
--    backs an expression index, and changing its output would silently stale that index.
--
-- Idempotent.

-- ── 1 ────────────────────────────────────────────────────────────────────
drop policy if exists "Own security events" on public.security_events;

-- ── 2 ────────────────────────────────────────────────────────────────────
revoke select on public.profiles from anon, authenticated;

do $$
declare
  v_cols text;
begin
  select string_agg(format('%I', a.attname), ', ' order by a.attnum)
    into v_cols
  from pg_attribute a
  where a.attrelid = 'public.profiles'::regclass
    and a.attnum > 0
    and not a.attisdropped
    and a.attname not in ('payout_wallet_address', 'payout_mpesa_phone', 'payout_bank_details');
  execute format('grant select (%s) on public.profiles to authenticated', v_cols);
end
$$;

-- ── 3 ────────────────────────────────────────────────────────────────────
create or replace function public.enforce_signup_policy()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_domain text;
begin
  if new.email is null then return new; end if;
  v_domain := lower(split_part(new.email, '@', 2));

  if new.email ~ '[\u0001-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]'
     or v_domain ~ '(^\.|\.$|\.\.)' then
    raise exception 'Please enter a valid email address.' using errcode = 'P0001';
  end if;
  if public.is_email_banned(new.email) then
    raise exception 'This email address cannot be used to register.' using errcode = 'P0001';
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

create or replace function public.enforce_email_change_policy()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_domain text;
begin
  if new.email_change is null or new.email_change = '' then return new; end if;
  if new.email_change is not distinct from old.email_change then return new; end if;
  v_domain := lower(split_part(new.email_change, '@', 2));

  if new.email_change ~ '[\u0001-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]'
     or v_domain ~ '(^\.|\.$|\.\.)' then
    raise exception 'Please enter a valid email address.' using errcode = 'P0001';
  end if;
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

revoke all on function public.enforce_signup_policy() from public, anon, authenticated;
revoke all on function public.enforce_email_change_policy() from public, anon, authenticated;

insert into public.schema_migrations (filename) values
  ('0101_auth_mfa_pass9.sql')
on conflict do nothing;
