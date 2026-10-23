-- ─────────────────────────────────────────────────────────────────────
-- 0071 · Auth & MFA — independent pass 5
--
--  1. mfa_verified_sessions.auth_session_id: the GoTrue login session
--     (auth.sessions.id = the JWT session_id claim) a verified / trusted
--     browser is currently signed in under. Lets "sign this device out" in
--     Settings end that browser's 2FA trust too; before, a browser holding a
--     30-day trusted cookie skipped the code on its next password sign-in even
--     after the owner had signed the device out.
--     Nullable on purpose: rows created before this migration simply have no
--     link (they keep working and expire on their own), and a browser that
--     signs in again re-links itself. Deliberately NOT a foreign key / cascade:
--     a normal sign-out deletes the auth.sessions row, and "trust this browser"
--     is meant to survive that.
-- Idempotent. Apply BEFORE / WITH the deploy (the app falls back to the old
-- row shape and logs a loud error until it exists).
-- ─────────────────────────────────────────────────────────────────────

alter table public.mfa_verified_sessions
  add column if not exists auth_session_id uuid;

create index if not exists mfa_verified_sessions_auth_session_idx
  on public.mfa_verified_sessions (user_id, auth_session_id)
  where auth_session_id is not null;

insert into public.schema_migrations (filename) values
  ('0071_auth_mfa_pass5.sql')
on conflict do nothing;
