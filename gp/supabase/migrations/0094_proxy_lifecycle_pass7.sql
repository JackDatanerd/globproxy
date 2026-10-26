-- 0094: Proxy lifecycle pass 7.
--
--  1. proxy_credentials.whitelist_replay_pending — set when putting a session's mirrored IP
--     whitelist back onto its re-provisioned sub-user failed; the cron retries it until it lands.
--     (Not granted to `authenticated`: 0059 grants an explicit column list, new columns are fail-closed.)
--  2. claim_pending_credentials gains p_credential_id so the customer's "Retry now" button
--     claims only the session that was clicked, not up to five of their pending sessions.
--  3. The asn column comment no longer names the upstream supplier (PostgREST publishes
--     column comments in its OpenAPI document).
-- Keep supabase/schema.sql in sync (scripts/check-schema-sync.mjs).

alter table public.proxy_credentials
  add column if not exists whitelist_replay_pending boolean not null default false;

create index if not exists proxy_credentials_whitelist_replay_idx
  on public.proxy_credentials (created_at)
  where whitelist_replay_pending and status = 'active';

drop function if exists public.claim_pending_credentials(integer, uuid, boolean);

create or replace function public.claim_pending_credentials(
  p_limit integer default 5,
  p_user_id uuid default null,
  p_ignore_backoff boolean default false,
  p_credential_id uuid default null
)
returns setof public.proxy_credentials
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  return query
  update public.proxy_credentials pc
  set provisioning_claimed_at = now(),
      provision_attempts = pc.provision_attempts + 1
  where pc.id in (
    select c.id from public.proxy_credentials c
    where c.status = 'pending'
      and c.created_by is null
      and (p_user_id is null or c.user_id = p_user_id)
      and (p_credential_id is null or c.id = p_credential_id)
      and not exists (
        select 1 from public.profiles p
        where p.id = c.user_id
          and (coalesce(p.is_suspended, false) or coalesce(p.is_deleted, false))
      )
      and (
        p_ignore_backoff
        or (
          c.provisioning_claimed_at is null
          or c.provisioning_claimed_at < now() - least(
               interval '3 minutes' * power(2, least(c.provision_attempts, 7)),
               interval '6 hours')
        )
      )
      and (c.provisioning_claimed_at is null or c.provisioning_claimed_at < now() - interval '2 minutes')
    order by c.created_at
    limit p_limit
    for update skip locked
  )
  returning pc.*;
end;
$$;

revoke all on function public.claim_pending_credentials(integer, uuid, boolean, uuid) from public, anon, authenticated;
grant execute on function public.claim_pending_credentials(integer, uuid, boolean, uuid) to service_role;

comment on column public.proxy_credentials.asn is
  'ISP/ASN targeting number (e.g. 13868) — appended to the username after city, before lifetime/session. Free text: no ASN-to-ISP-name mapping is kept.';

insert into public.schema_migrations (filename) values
  ('0094_proxy_lifecycle_pass7.sql')
on conflict do nothing;
