-- ============================================================
-- 0039 — Auth & MFA hardening
-- ============================================================
-- Fresh-pass audit of Auth & MFA. Everything here is the database half of
-- fixes whose application half lives in lib/mfa.ts, lib/securityEvents.ts
-- and app/api/auth/*.
--
--  1. profiles.mfa_enabled was user-writable. protect_privileged_profile_columns
--     never listed it, and "Update own profile" lets a signed-in user update
--     their own row through PostgREST. With MFA now optional (the flag is the
--     ONLY thing that makes middleware demand a second factor from a user
--     who enrolled), anyone holding just the password could run
--       update profiles set mfa_enabled = false
--     and walk past step-up. Pinned here. The only legitimate writers are
--     confirm_totp_enrollment() / wipe_mfa() (security definer, run with
--     auth.uid() null, which the trigger already lets through).
--
--  2. Lockout counter + TOTP replay protection were read-modify-write from
--     application code. N parallel guesses all read failed_attempts = 0 and
--     all wrote 1, so the lock never tripped; the same code submitted twice
--     concurrently both passed the last_used_counter check. Replaced with
--     single-statement atomic RPCs:
--       mfa_begin_attempt(user, max, lock_seconds) — reserves one attempt
--         budget slot BEFORE the code is checked, or says 'locked'.
--       mfa_consume_totp(user, counter) — compare-and-set on
--         last_used_counter, also clears the failure counter and lock.
--       mfa_refund_attempt(user) — gives the slot back when a check failed
--         for infrastructure reasons, so an outage can't burn the budget.
--
--  3. security_events — per-user audit trail (sign-ins, password / email /
--     MFA changes, lockouts). Users can read their own rows (Settings →
--     recent activity); nobody can write from the client.
--
--  4. Password-change trigger on auth.users. The "your password was changed"
--     notice used to depend on the browser calling /api/auth/notify-password-
--     changed after updateUser() — anyone calling the Supabase API directly
--     skipped it. This trigger records the event (notify = true) no matter
--     how the password changed, and revokes every MFA "verified browser"
--     session for the user in the same transaction. Notices are delivered
--     by lib/securityEvents.ts (immediately where the app knows about the
--     change, otherwise by the 'security' cron task).
--
--  5. auth_email_unconfirmed() — lets signup / resend-confirmation tell
--     "exists and never confirmed" apart from "exists and confirmed"
--     without exposing the difference to the caller.

-- ── 1. Pin mfa_enabled ──────────────────────────────────────────
create or replace function public.protect_privileged_profile_columns()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return new; -- service-role client; app code already gates this
  end if;

  if public.is_admin(auth.uid()) then
    return new;
  end if;

  new.role                               := old.role;
  new.is_suspended                       := old.is_suspended;
  new.suspended_at                       := old.suspended_at;
  new.suspension_reason                  := old.suspension_reason;
  new.reseller_status                    := old.reseller_status;
  new.api_access                         := old.api_access;
  new.api_access_status                  := old.api_access_status;
  new.is_deleted                         := old.is_deleted;
  new.deleted_at                         := old.deleted_at;
  new.email                              := old.email; -- see migration 0011 — the sync trigger below is how email changes actually land
  new.affiliate_status                   := old.affiliate_status; -- see migration 0031
  new.affiliate_commission_rate          := old.affiliate_commission_rate;
  new.affiliate_commission_rate_lifetime := old.affiliate_commission_rate_lifetime;
  new.payout_method                      := old.payout_method;
  new.payout_wallet_address              := old.payout_wallet_address;
  new.payout_wallet_network              := old.payout_wallet_network;
  new.payout_bank_details                := old.payout_bank_details;
  new.payout_mpesa_phone                 := old.payout_mpesa_phone;
  new.payout_method_updated_at           := old.payout_method_updated_at;
  new.is_verified_operator               := old.is_verified_operator; -- see migration 0037
  new.verified_operator_since            := old.verified_operator_since;
  new.mfa_enabled                        := old.mfa_enabled; -- see migration 0039

  return new;
end;
$$;

-- Repair: a profile whose flag was flipped by hand while a confirmed factor
-- exists (or vice versa) gets re-synced to the factor table, which is the
-- source of truth.
update public.profiles p
set mfa_enabled = exists (
  select 1 from public.mfa_totp_factors f where f.user_id = p.id and f.confirmed = true
)
where p.mfa_enabled is distinct from exists (
  select 1 from public.mfa_totp_factors f where f.user_id = p.id and f.confirmed = true
);

-- ── 2. Atomic attempt budget / TOTP consumption ─────────────────
-- Returns: 'ok'     — slot reserved, go ahead and check the code
--          'ok_last'— slot reserved and it was the last one; the factor is
--                     now locked for p_lock_seconds unless this attempt succeeds
--          'locked' — currently locked, do not check the code
--          'missing'— no factor row
create or replace function public.mfa_begin_attempt(
  p_user_id uuid,
  p_max integer,
  p_lock_seconds integer
)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row public.mfa_totp_factors%rowtype;
  v_attempts integer;
begin
  select * into v_row from public.mfa_totp_factors where user_id = p_user_id for update;
  if not found then
    return 'missing';
  end if;

  if v_row.locked_until is not null and v_row.locked_until > now() then
    return 'locked';
  end if;

  -- An expired lock starts a fresh budget.
  v_attempts := case when v_row.locked_until is not null then 1 else v_row.failed_attempts + 1 end;

  if v_attempts >= p_max then
    update public.mfa_totp_factors
      set failed_attempts = 0,
          locked_until = now() + make_interval(secs => p_lock_seconds)
      where user_id = p_user_id;
    return 'ok_last';
  end if;

  update public.mfa_totp_factors
    set failed_attempts = v_attempts,
        locked_until = null
    where user_id = p_user_id;
  return 'ok';
end;
$$;

revoke all on function public.mfa_begin_attempt(uuid, integer, integer) from public;
grant execute on function public.mfa_begin_attempt(uuid, integer, integer) to service_role;

-- Compare-and-set: succeeds only if p_counter is strictly newer than the
-- last consumed one. A success also clears the failure counter and lock.
create or replace function public.mfa_consume_totp(p_user_id uuid, p_counter bigint)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.mfa_totp_factors
    set last_used_counter = p_counter,
        last_used_at = now(),
        failed_attempts = 0,
        locked_until = null
    where user_id = p_user_id
      and (last_used_counter is null or last_used_counter < p_counter);
  return found;
end;
$$;

revoke all on function public.mfa_consume_totp(uuid, bigint) from public;
grant execute on function public.mfa_consume_totp(uuid, bigint) to service_role;

-- Clears failures after a successful BACKUP-code check (which has its own
-- single-use protection via mfa_backup_codes.used_at).
create or replace function public.mfa_clear_failures(p_user_id uuid)
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.mfa_totp_factors
    set failed_attempts = 0, locked_until = null, last_used_at = now()
    where user_id = p_user_id;
$$;

revoke all on function public.mfa_clear_failures(uuid) from public;
grant execute on function public.mfa_clear_failures(uuid) to service_role;

create or replace function public.mfa_refund_attempt(p_user_id uuid)
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.mfa_totp_factors
    set failed_attempts = greatest(failed_attempts - 1, 0)
    where user_id = p_user_id and failed_attempts > 0;
$$;

revoke all on function public.mfa_refund_attempt(uuid) from public;
grant execute on function public.mfa_refund_attempt(uuid) to service_role;

-- ── 3. Security events ──────────────────────────────────────────
create table if not exists public.security_events (
  id           uuid default uuid_generate_v4() primary key,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  actor_id     uuid,                       -- set when someone other than the user caused it (admin MFA reset)
  event        text not null,
  ip           text,
  user_agent   text,
  meta         jsonb not null default '{}'::jsonb,
  notify       boolean not null default false,   -- an email is owed for this event
  notified_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists security_events_user_created_idx
  on public.security_events(user_id, created_at desc);
create index if not exists security_events_pending_notice_idx
  on public.security_events(created_at) where notify and notified_at is null;
create index if not exists security_events_login_ua_idx
  on public.security_events(user_id, (meta->>'ua_hash')) where event = 'login';

alter table public.security_events enable row level security;

drop policy if exists "Own security events" on public.security_events;
create policy "Own security events" on public.security_events
  for select using (auth.uid() = user_id);
-- No insert/update/delete policies: every write goes through the
-- service-role client (lib/securityEvents.ts) or the triggers below.

create or replace function public.cleanup_old_security_events()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_deleted integer;
begin
  delete from public.security_events where created_at < now() - interval '365 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.cleanup_old_security_events() from public, anon, authenticated;
grant execute on function public.cleanup_old_security_events() to service_role;

-- ── 4. Password-change trigger ──────────────────────────────────
create or replace function public.on_auth_password_changed()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.encrypted_password is distinct from old.encrypted_password
     and old.encrypted_password is not null then
    delete from public.mfa_verified_sessions where user_id = new.id;
    insert into public.security_events (user_id, event, notify, meta)
    select new.id, 'password_changed', true, jsonb_build_object('source', 'db_trigger')
    where exists (select 1 from public.profiles where id = new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_password_changed on auth.users;
create trigger on_auth_user_password_changed
  after update of encrypted_password on auth.users
  for each row execute procedure public.on_auth_password_changed();

-- ── 5. Unconfirmed-account lookup ───────────────────────────────
create or replace function public.auth_email_unconfirmed(check_email text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from auth.users
    where lower(email) = lower(check_email)
      and email_confirmed_at is null
      and (banned_until is null or banned_until < now())
  );
$$;

revoke all on function public.auth_email_unconfirmed(text) from public, anon, authenticated;
grant execute on function public.auth_email_unconfirmed(text) to service_role;

insert into public.schema_migrations (filename) values
  ('0039_auth_mfa_hardening.sql')
on conflict do nothing;
