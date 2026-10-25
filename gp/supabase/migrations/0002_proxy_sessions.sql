-- Persisted, user-managed sticky sessions. Previously, sticky "sessions"
-- were purely ephemeral — a new random session ID generated on every page
-- render (lib/proxyEndpoint.ts genSessionId()), so there was nothing to
-- rename, pin, collapse, or terminate: it wasn't a real record anywhere.
-- This table makes a session an actual thing the user creates once and
-- manages over time, while the underlying session ID/lifetime encoding in
-- the connection string is unchanged.
create table if not exists public.proxy_sessions (
  id              uuid default uuid_generate_v4() primary key,
  credential_id   uuid references public.proxy_credentials(id) on delete cascade not null,
  user_id         uuid references public.profiles(id) on delete cascade not null,
  session_token   text not null, -- the actual upstream session id, e.g. "mBXMRo" — fixed at creation, not regenerated
  label           text not null default 'Session',
  pinned          boolean not null default false,
  collapsed       boolean not null default false,
  terminated_at   timestamp with time zone, -- soft "forget" — upstream has no endpoint to force-expire early,
                                             -- so this just stops it from showing in the active list
  created_at      timestamp with time zone default now()
);

create index if not exists proxy_sessions_credential_id_idx on public.proxy_sessions(credential_id);
create index if not exists proxy_sessions_user_id_idx on public.proxy_sessions(user_id);

alter table public.proxy_sessions enable row level security;

create policy "Users can view their own sessions"
  on public.proxy_sessions for select
  using (auth.uid() = user_id);

create policy "Users can create their own sessions"
  on public.proxy_sessions for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own sessions"
  on public.proxy_sessions for update
  using (auth.uid() = user_id);

create policy "Users can delete their own sessions"
  on public.proxy_sessions for delete
  using (auth.uid() = user_id);
