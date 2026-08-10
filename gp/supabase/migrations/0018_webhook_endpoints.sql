-- ============================================================
-- 0018 — User-facing webhooks
-- ============================================================
-- Two events for v1: 'session_created' and 'bandwidth_threshold_crossed'
-- (fired from the same 80%/95% account-level check runBandwidthAlerts()
-- already does — see app/api/cron/[task]/route.ts — so there's exactly
-- one place deciding "has this account crossed a bandwidth threshold,"
-- whether the result goes out as an email, a webhook, or both).
--
-- The signing secret (webhook_endpoints.secret) is stored in plaintext,
-- unlike api_keys.key_hash (migration 0005) — and that's deliberate, not
-- an oversight: an API key is only ever compared against an incoming
-- attempt, so a one-way hash works. A webhook secret has to be read back
-- in full at send time to compute the outgoing HMAC signature, so it
-- can't be one-way hashed. It's protected the same way api_keys always
-- has been instead: RLS restricts it to select-by-owner only, and no
-- application code ever returns it in a list response after creation —
-- only the create response includes it, once.

create table if not exists public.webhook_endpoints (
  id               uuid default uuid_generate_v4() primary key,
  user_id          uuid references public.profiles(id) on delete cascade not null,
  url              text not null,
  secret           text not null,
  event_types      text[] not null default '{}',
  enabled          boolean not null default true,
  created_at       timestamptz not null default now(),
  last_success_at  timestamptz,
  last_failure_at  timestamptz,
  last_error       text
);

create index if not exists webhook_endpoints_user_id_idx on public.webhook_endpoints(user_id);
-- Lets dispatchWebhook() find "who's subscribed to event X" directly via
-- the `.contains()` query instead of loading every endpoint and filtering
-- in application code.
create index if not exists webhook_endpoints_event_types_idx
  on public.webhook_endpoints using gin(event_types);

alter table public.webhook_endpoints
  add constraint webhook_endpoints_https_only check (url ~* '^https://');

-- Defense-in-depth alongside the app-layer check in the API routes —
-- even a bug in application code can't get an unrecognized event type
-- persisted here.
alter table public.webhook_endpoints
  add constraint webhook_endpoints_valid_events
    check (event_types <@ array['session_created', 'bandwidth_threshold_crossed']::text[]);

alter table public.webhook_endpoints enable row level security;

drop policy if exists "Users can view own webhook endpoints" on public.webhook_endpoints;
create policy "Users can view own webhook endpoints"
  on public.webhook_endpoints for select
  using (auth.uid() = user_id);

-- Deliberately no client insert/update/delete policy, same reasoning as
-- api_keys (0005): creating one requires generating the secret
-- server-side, and every mutation — including just editing the URL or
-- flipping enabled — needs to re-run the SSRF guard (lib/ssrfGuard.ts)
-- against the URL, which RLS has no way to do. All writes go through
-- /api/dashboard/webhooks/* using the service role after an explicit
-- ownership check.
