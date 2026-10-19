-- 0045_auth_mfa_closeout.sql
-- Section 2 (Auth & MFA) close-out round.
--
--  A. Atomic MFA enrollment / backup-code regeneration, per-user unique
--     backup-code hashes, guarded start-enrollment, last-slot lock refund.
--  B. Trusted-browser metadata on mfa_verified_sessions.
--  C. Per-account login throttle (auth_throttle).
--  D. Pre-hijack fix support: auth_unconfirmed_user_id(); password-change
--     trigger ignores unconfirmed accounts.
--  E. Email-change trigger -> security event (notice goes to the OLD address).
--  F. Signup policy enforced IN THE DATABASE (before insert on auth.users):
--     ban list (plus-address aware) + disposable domains. A direct GoTrue
--     signup with the public anon key can no longer skip it.
--  G. Active-session list / revoke helpers over auth.sessions.
--  H. Self-service "lost my authenticator" recovery with a waiting period.
--  I. cleanup_old_security_events() also sweeps throttle + recovery rows.
--  J. The payout-hold trigger from 0044 also fires on email_changed and
--     mfa_recovery_completed.
--
-- Every function below is SECURITY DEFINER with a pinned search_path and is
-- executable by service_role only.

-- ── A. MFA atomicity ───────────────────────────────────────────────
drop index if exists public.mfa_backup_codes_hash_idx;
create unique index if not exists mfa_backup_codes_user_hash_idx
  on public.mfa_backup_codes(user_id, code_hash);

create or replace function public.mfa_replace_backup_codes(p_user_id uuid, p_hashes text[])
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Serialise concurrent regenerations for the same user.
  perform 1 from public.mfa_totp_factors where user_id = p_user_id for update;
  if not found then
    raise exception 'No MFA factor for this account.' using errcode = 'P0002';
  end if;
  delete from public.mfa_backup_codes where user_id = p_user_id and used_at is null;
  insert into public.mfa_backup_codes (user_id, code_hash)
    select p_user_id, h from unnest(p_hashes) as h;
end;
$$;

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
end;
$$;

-- Returns false (and changes nothing) when the factor is already confirmed.
create or replace function public.mfa_start_enrollment(p_user_id uuid, p_secret text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_rows integer;
begin
  insert into public.mfa_totp_factors (user_id, secret, confirmed, last_used_counter)
  values (p_user_id, p_secret, false, null)
  on conflict (user_id) do update
    set secret = excluded.secret, confirmed = false, last_used_counter = null, created_at = now()
    where public.mfa_totp_factors.confirmed = false;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- Refund now understands the "last slot" reservation: mfa_begin_attempt
-- locks the factor on the 5th reservation, so an infrastructure error on
-- that attempt must lift the lock again.
drop function if exists public.mfa_refund_attempt(uuid);
create or replace function public.mfa_refund_attempt(
  p_user_id uuid, p_was_last boolean default false, p_max integer default 5
)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_was_last then
    update public.mfa_totp_factors
      set failed_attempts = greatest(p_max - 1, 0), locked_until = null
      where user_id = p_user_id and locked_until is not null and locked_until > now();
  else
    update public.mfa_totp_factors
      set failed_attempts = greatest(failed_attempts - 1, 0)
      where user_id = p_user_id and failed_attempts > 0;
  end if;
end;
$$;

-- ── B. Trusted-browser metadata ────────────────────────────────────
alter table public.mfa_verified_sessions
  add column if not exists remembered boolean not null default false,
  add column if not exists user_agent text,
  add column if not exists ip text;

-- ── C. Per-account login throttle ──────────────────────────────────
create table if not exists public.auth_throttle (
  key          text primary key,            -- sha-256 of the lower-cased email
  hits         integer not null default 0,
  window_start timestamptz not null default now(),
  notified     boolean not null default false
);
alter table public.auth_throttle enable row level security;

-- Counts one attempt. Returns 'ok', 'blocked_first' (first block in this
-- window — the caller sends the owner one alert) or 'blocked'.
create or replace function public.auth_throttle_hit(p_key text, p_max integer, p_window_s integer)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare r record;
begin
  insert into public.auth_throttle as t (key, hits, window_start)
  values (p_key, 1, now())
  on conflict (key) do update set
    hits = case when t.window_start < now() - make_interval(secs => p_window_s) then 1 else t.hits + 1 end,
    notified = case when t.window_start < now() - make_interval(secs => p_window_s) then false else t.notified end,
    window_start = case when t.window_start < now() - make_interval(secs => p_window_s) then now() else t.window_start end
  returning t.hits, t.notified into r;

  if r.hits <= p_max then return 'ok'; end if;
  if not r.notified then
    update public.auth_throttle set notified = true where key = p_key;
    return 'blocked_first';
  end if;
  return 'blocked';
end;
$$;

create or replace function public.auth_throttle_clear(p_key text)
returns void language sql security definer set search_path = public, pg_temp as $$
  delete from public.auth_throttle where key = p_key;
$$;

-- ── D. Pre-hijack support ──────────────────────────────────────────
create or replace function public.auth_unconfirmed_user_id(check_email text)
returns uuid language sql stable security definer set search_path = public as $$
  select id from auth.users
  where lower(email) = lower(check_email)
    and email_confirmed_at is null
    and (banned_until is null or banned_until < now())
  limit 1;
$$;

-- Replacing the password of an UNCONFIRMED account (a new signup for the
-- same address) is not a "password changed" event: nobody has signed in yet.
create or replace function public.on_auth_password_changed()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.encrypted_password is distinct from old.encrypted_password
     and old.encrypted_password is not null
     and new.email_confirmed_at is not null then
    delete from public.mfa_verified_sessions where user_id = new.id;
    insert into public.security_events (user_id, event, notify, meta)
    select new.id, 'password_changed', true, jsonb_build_object('source', 'db_trigger')
    where exists (select 1 from public.profiles where id = new.id);
  end if;
  return new;
end;
$$;

-- ── E. Email-change completed -> event (+ notice to the old address) ──
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
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute procedure public.on_auth_email_changed();

-- ── F. Signup policy in the database ───────────────────────────────
create table if not exists public.disposable_email_domains (
  domain text primary key
);
alter table public.disposable_email_domains enable row level security;

insert into public.disposable_email_domains (domain) values
  ('10minutemail.co.uk'),
  ('10minutemail.com'),
  ('10minutemail.net'),
  ('1secmail.com'),
  ('1secmail.net'),
  ('1secmail.org'),
  ('20minutemail.com'),
  ('anonbox.net'),
  ('burnermail.io'),
  ('cs.email'),
  ('discard.email'),
  ('dispostable.com'),
  ('dropmail.me'),
  ('emailfake.com'),
  ('emailondeck.com'),
  ('emltmp.com'),
  ('fakeinbox.com'),
  ('fakemailgenerator.com'),
  ('filzmail.com'),
  ('getairmail.com'),
  ('getnada.com'),
  ('gmailnator.com'),
  ('grr.la'),
  ('guerrillamail.biz'),
  ('guerrillamail.com'),
  ('guerrillamail.de'),
  ('guerrillamail.info'),
  ('guerrillamail.net'),
  ('guerrillamail.org'),
  ('guerrillamailblock.com'),
  ('harakirimail.com'),
  ('inboxkitten.com'),
  ('incognitomail.org'),
  ('jetable.org'),
  ('linshiyouxiang.net'),
  ('luxusmail.org'),
  ('mail-temp.com'),
  ('mail.tm'),
  ('mailcatch.com'),
  ('maildax.me'),
  ('maildrop.cc'),
  ('mailforspam.com'),
  ('mailinator.com'),
  ('mailnesia.com'),
  ('mailnull.com'),
  ('mailpoof.com'),
  ('mailsac.com'),
  ('mailtemp.info'),
  ('mintemail.com'),
  ('minuteinbox.com'),
  ('moakt.com'),
  ('mohmal.com'),
  ('mytemp.email'),
  ('nada.email'),
  ('nowmymail.com'),
  ('pokemail.net'),
  ('pookmail.com'),
  ('sharklasers.com'),
  ('spam4.me'),
  ('spambox.us'),
  ('spamex.com'),
  ('spamgourmet.com'),
  ('spamoff.de'),
  ('temp-mail.io'),
  ('temp-mail.org'),
  ('tempail.com'),
  ('tempinbox.com'),
  ('tempmail.com'),
  ('tempmail.net'),
  ('tempmail.org'),
  ('tempmailo.com'),
  ('tempr.email'),
  ('throwam.com'),
  ('throwaway.email'),
  ('throwawaymail.com'),
  ('tmail.ws'),
  ('tmpmail.net'),
  ('tmpmail.org'),
  ('trash-mail.com'),
  ('trashmail.com'),
  ('trashmail.de'),
  ('trashmail.me'),
  ('trashmail.net'),
  ('trbvm.com'),
  ('wegwerfadresse.de'),
  ('wegwerfemail.de'),
  ('wh4f.org'),
  ('yopmail.com'),
  ('yopmail.fr'),
  ('yopmail.net')
on conflict do nothing;

create or replace function public.normalize_ban_email(p text)
returns text language sql immutable as $$
  select lower(regexp_replace(split_part(trim(p), '@', 1), '\+.*$', '')) || '@' || lower(split_part(trim(p), '@', 2));
$$;

create index if not exists banned_emails_normalized_idx
  on public.banned_emails (public.normalize_ban_email(email));

create or replace function public.is_email_banned(check_email text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.banned_emails b
    where public.normalize_ban_email(b.email) = public.normalize_ban_email(check_email)
  );
$$;

create or replace function public.enforce_signup_policy()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_domain text;
begin
  if new.email is null then return new; end if;
  v_domain := lower(split_part(new.email, '@', 2));

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

drop trigger if exists enforce_signup_policy on auth.users;
create trigger enforce_signup_policy
  before insert on auth.users
  for each row execute procedure public.enforce_signup_policy();

-- ── G. Active-session helpers ──────────────────────────────────────
create or replace function public.list_auth_sessions(p_user_id uuid)
returns jsonb language sql stable security definer set search_path = public, auth, pg_temp as $$
  select coalesce(
    jsonb_agg(
      to_jsonb(s) - 'refresh_token_hmac_key' - 'refresh_token_counter' - 'factor_id' - 'oauth_client_id'
      order by s.updated_at desc nulls last
    ),
    '[]'::jsonb
  )
  from auth.sessions s
  where s.user_id = p_user_id;
$$;

create or replace function public.revoke_auth_session(p_user_id uuid, p_session_id uuid)
returns boolean language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare n integer;
begin
  delete from auth.sessions where id = p_session_id and user_id = p_user_id;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

-- ── H. Self-service MFA recovery (waiting period) ──────────────────
create table if not exists public.mfa_recovery_requests (
  id           uuid default uuid_generate_v4() primary key,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  token_hash   text not null unique,         -- sha-256 of the emailed token
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,         -- the emailed link is valid until here
  confirmed_at timestamptz,                  -- link opened + password re-entered: the clock starts
  ready_at     timestamptz,                  -- earliest moment the reset may complete
  cancelled_at timestamptz,
  completed_at timestamptz
);
create index if not exists mfa_recovery_requests_user_idx on public.mfa_recovery_requests(user_id, created_at desc);
alter table public.mfa_recovery_requests enable row level security;

-- ── I. Cleanup ─────────────────────────────────────────────────────
create or replace function public.cleanup_old_security_events()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_deleted integer;
begin
  delete from public.security_events where created_at < now() - interval '365 days';
  get diagnostics v_deleted = row_count;
  delete from public.auth_throttle where window_start < now() - interval '1 day';
  delete from public.mfa_recovery_requests where created_at < now() - interval '90 days';
  return v_deleted;
end;
$$;

-- ── J. Payout hold (0044 §12c) learns the new takeover steps ────
-- A completed email change and a completed 2FA recovery are exactly the
-- account-takeover steps the 48h payout-method hold exists for.
create or replace function public.bump_payout_hold_on_security_event()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.event in ('password_changed', 'email_change_requested', 'mfa_disabled',
                   'mfa_reset_by_admin', 'mfa_backup_regenerated',
                   'email_changed', 'mfa_recovery_completed') then
    update public.profiles
    set payout_method_updated_at = now()
    where id = new.user_id and payout_method is not null;
  end if;
  return new;
end;
$$;

-- ── Grants: service_role only ──────────────────────────────────────
revoke all on function public.mfa_replace_backup_codes(uuid, text[]) from public, anon, authenticated;
revoke all on function public.confirm_totp_enrollment_atomic(uuid, integer, text[]) from public, anon, authenticated;
revoke all on function public.mfa_start_enrollment(uuid, text) from public, anon, authenticated;
revoke all on function public.mfa_refund_attempt(uuid, boolean, integer) from public, anon, authenticated;
revoke all on function public.auth_throttle_hit(text, integer, integer) from public, anon, authenticated;
revoke all on function public.auth_throttle_clear(text) from public, anon, authenticated;
revoke all on function public.auth_unconfirmed_user_id(text) from public, anon, authenticated;
revoke all on function public.on_auth_email_changed() from public, anon, authenticated;
revoke all on function public.normalize_ban_email(text) from public, anon, authenticated;
revoke all on function public.is_email_banned(text) from public, anon, authenticated;
revoke all on function public.enforce_signup_policy() from public, anon, authenticated;
revoke all on function public.list_auth_sessions(uuid) from public, anon, authenticated;
revoke all on function public.revoke_auth_session(uuid, uuid) from public, anon, authenticated;
revoke all on function public.cleanup_old_security_events() from public, anon, authenticated;

grant execute on function public.mfa_replace_backup_codes(uuid, text[]) to service_role;
grant execute on function public.confirm_totp_enrollment_atomic(uuid, integer, text[]) to service_role;
grant execute on function public.mfa_start_enrollment(uuid, text) to service_role;
grant execute on function public.mfa_refund_attempt(uuid, boolean, integer) to service_role;
grant execute on function public.auth_throttle_hit(text, integer, integer) to service_role;
grant execute on function public.auth_throttle_clear(text) to service_role;
grant execute on function public.auth_unconfirmed_user_id(text) to service_role;
grant execute on function public.normalize_ban_email(text) to service_role;
grant execute on function public.is_email_banned(text) to service_role;
grant execute on function public.list_auth_sessions(uuid) to service_role;
grant execute on function public.revoke_auth_session(uuid, uuid) to service_role;
grant execute on function public.cleanup_old_security_events() to service_role;

insert into public.schema_migrations (filename) values
  ('0045_auth_mfa_closeout.sql')
on conflict do nothing;
