-- ============================================================
-- 0005 — Real API keys
-- The "API Keys" dashboard page was displaying the user's live Supabase
-- session access_token (a JWT) labeled as if it were a durable API key:
--   - it expires (session JWTs are short-lived), so anything built against
--     it as shown breaks silently within roughly an hour
--   - it's not scoped to the API — it's full session-equivalent auth
--   - there was no api_keys table anywhere, no generation, no revocation
-- This migration adds a real, hashed, revocable API key store.
-- ============================================================

create table if not exists public.api_keys (
  id           uuid default uuid_generate_v4() primary key,
  user_id      uuid references public.profiles(id) on delete cascade not null,
  key_hash     text not null unique,   -- sha-256 hex digest; plaintext is shown once at creation and never stored
  key_prefix   text not null,          -- first chars of the plaintext key, for the user to recognize it in a list
  label        text not null default 'Default key',
  created_at   timestamp with time zone default now(),
  last_used_at timestamp with time zone,
  revoked_at   timestamp with time zone
);

create index if not exists api_keys_user_id_idx on public.api_keys(user_id);

alter table public.api_keys enable row level security;

drop policy if exists "Users can view own api keys" on public.api_keys;
create policy "Users can view own api keys"
  on public.api_keys for select
  using (auth.uid() = user_id);

-- Revoking is just setting revoked_at — allow the owner to do that directly.
-- Creating a key requires generating and hashing the plaintext server-side
-- (service role), so there's deliberately no client insert policy.
drop policy if exists "Users can revoke own api keys" on public.api_keys;
create policy "Users can revoke own api keys"
  on public.api_keys for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id and revoked_at is not null);
