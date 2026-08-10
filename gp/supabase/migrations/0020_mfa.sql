-- ============================================================
-- 0020 — Two-factor authentication (TOTP + backup codes)
-- ============================================================
-- Mandatory for admin and reseller roles (enforced in application code —
-- middleware.ts + the three protected layouts — not here; this migration
-- only lays down the storage). Optional and available to any user.
--
-- Three tables:
--   mfa_totp_factors      — one row per user, the authenticator-app secret
--   mfa_backup_codes      — one-time recovery codes, hashed like api_keys
--   mfa_verified_sessions — short-lived "this browser session completed
--                           its second factor" tokens. Supabase's own
--                           session (the JWT in the cookie) has no concept
--                           of our custom TOTP step-up, so this is a
--                           second, independent proof-of-recent-MFA that
--                           middleware checks on every protected request
--                           for admin/reseller accounts.
--
-- All three are RLS-enabled with NO client policies at all — every access
-- path goes through server routes using the service-role admin client
-- with an explicit, code-level user_id check (see lib/mfa.ts), the same
-- "no direct client access, ever" posture migration 0012 pushed the
-- money-moving RPCs toward. A TOTP secret or a backup-code hash has no
-- legitimate reason to ever be readable via a client-side supabase.from()
-- call, unlike api_keys (0005) which deliberately lets an owner list their
-- own key hashes/prefixes.

create table public.mfa_totp_factors (
  user_id        uuid primary key references public.profiles(id) on delete cascade,
  secret         text not null,          -- base32 TOTP secret. Shown to the user once, at enrollment, then never again.
  confirmed      boolean not null default false,
  failed_attempts integer not null default 0,
  locked_until   timestamptz,            -- brute-force lockout after MAX_FAILED_ATTEMPTS (lib/mfa.ts)
  created_at     timestamptz not null default now(),
  confirmed_at   timestamptz,
  last_used_at   timestamptz
);

alter table public.mfa_totp_factors enable row level security;

create table public.mfa_backup_codes (
  id          uuid default uuid_generate_v4() primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  code_hash   text not null,   -- sha-256 hex digest of the plaintext code; plaintext is shown once at generation and never stored
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index mfa_backup_codes_user_id_idx on public.mfa_backup_codes(user_id);
-- Fast "does this user have unused codes left" / lookup-by-hash path —
-- both the settings page count and consumeBackupCode() filter on this.
create index mfa_backup_codes_unused_idx on public.mfa_backup_codes(user_id) where used_at is null;
create unique index mfa_backup_codes_hash_idx on public.mfa_backup_codes(code_hash);

alter table public.mfa_backup_codes enable row level security;

create table public.mfa_verified_sessions (
  token_hash  text primary key,   -- sha-256 hex digest of the opaque cookie value
  user_id     uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

create index mfa_verified_sessions_user_id_idx on public.mfa_verified_sessions(user_id);
-- Middleware's hot-path lookup is by token_hash (the primary key) alone;
-- this second index just makes "revoke everything for this user" (used on
-- disable/reset) and the cron sweep below cheap too.
create index mfa_verified_sessions_expires_idx on public.mfa_verified_sessions(expires_at);

alter table public.mfa_verified_sessions enable row level security;

-- Denormalized onto profiles so middleware's existing single profile
-- fetch (role, is_suspended) can add mfa_enabled to the same query
-- instead of a second round trip on every protected request. Kept in
-- sync exclusively by lib/mfa.ts (confirmEnrollment sets it true,
-- disableMfa/adminResetMfa set it false) — never written anywhere else.
alter table public.profiles add column if not exists mfa_enabled boolean not null default false;

-- Cron cleanup — mirrors the existing app/api/cron/[task]/route.ts task
-- registry pattern. Expired rows are already functionally inert (any
-- lookup filters expires_at > now()), this just keeps the table from
-- growing unbounded on a long-lived deployment.
create or replace function public.cleanup_expired_mfa_sessions()
returns void
language sql
security definer
as $$
  delete from public.mfa_verified_sessions where expires_at < now();
$$;

revoke all on function public.cleanup_expired_mfa_sessions() from public, anon, authenticated;
