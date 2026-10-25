-- 0079_proxy_lifecycle_pass3.sql
-- Proxy lifecycle, independent pass 3 (fix round):
--
--  1. proxy_whitelist_entries: a local mirror of each session's IP whitelist.
--     The whitelist used to exist ONLY at the supplier, so a session that had to be
--     re-created lost it silently (a less restrictive session, with nobody told).
--     proxy_credentials.whitelist_mirrored_at marks sessions whose mirror is current.
--  2. reprovision_credential(): turns an ACTIVE session whose sub-user no longer exists
--     upstream back into a PENDING one that the normal provisioning pipeline brings up
--     again, with its remaining allocation (allocated minus what it already consumed).
--  3. proxy_credentials.exhausted_email_due / low_email_due: a notice that was claimed
--     but did not get an e-mail slot in this tick is still owed an e-mail on the next
--     one. Before, the flag that suppresses repeats was set for every claimed session,
--     so sessions past the per-run e-mail cap were never e-mailed at all.
--
-- New proxy_credentials columns are NOT granted to `authenticated` (0059 grants an
-- explicit column list; new columns are fail-closed).
-- Keep supabase/schema.sql in sync (scripts/check-schema-sync.mjs).

-- ── 1. Whitelist mirror ───────────────────────────────────────
alter table public.proxy_credentials
  add column if not exists whitelist_mirrored_at timestamptz,
  add column if not exists exhausted_email_due   boolean not null default false,
  add column if not exists low_email_due         boolean not null default false;

create table if not exists public.proxy_whitelist_entries (
  credential_id uuid not null references public.proxy_credentials(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  ip            text not null check (char_length(ip) between 2 and 45),
  description   text not null default '' check (char_length(description) <= 100),
  created_at    timestamptz not null default now(),
  primary key (credential_id, ip)
);

create index if not exists proxy_whitelist_entries_user_idx
  on public.proxy_whitelist_entries (user_id);

-- Written and read only by the server (service role). No policy for end users: the
-- authoritative list is what the dashboard shows from the supplier; this is the copy
-- used to rebuild it.
alter table public.proxy_whitelist_entries enable row level security;
revoke all on public.proxy_whitelist_entries from anon, authenticated;

-- Partial index: the cron backfill only ever looks for sessions not mirrored yet.
create index if not exists proxy_credentials_whitelist_unmirrored_idx
  on public.proxy_credentials (created_at)
  where status = 'active' and whitelist_mirrored_at is null and upstream_sub_user_id is not null;

-- ── 2. reprovision_credential ─────────────────────────────────
-- p_live_used_gb: the supplier's live figure when it could still be read (NULL when the
-- sub-user is gone, which is the point). The larger of it and the last synced gb_used
-- counts as consumed. What was consumed is archived into the account exactly as a
-- delete does (the GB stay inside allocated_gb, so they remain spent), and the session
-- keeps only what is left, with a fresh usage counter for its new sub-user.
create or replace function public.reprovision_credential(
  p_credential_id uuid,
  p_live_used_gb numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c record;
  v_used numeric;
  v_new  numeric;
begin
  select * into c
  from public.proxy_credentials
  where id = p_credential_id
  for update;

  if not found then
    raise exception 'Credential not found' using errcode = 'P0002';
  end if;
  if c.created_by is not null then
    raise exception 'Reseller-allocated sessions cannot be re-provisioned automatically' using errcode = '42501';
  end if;
  if c.status <> 'active' then
    raise exception 'Only an active session can be re-provisioned (status: %)', c.status using errcode = 'P0005';
  end if;

  v_used := greatest(coalesce(c.gb_used, 0), coalesce(p_live_used_gb, 0), 0);
  v_new  := round(c.gb_allocated - v_used, 4);
  if v_new < 0.01 then
    raise exception 'Nothing is left on this session to re-provision (allocated %, used %)', c.gb_allocated, v_used using errcode = 'P0004';
  end if;

  update public.proxy_credentials
  set status = 'pending',
      gb_allocated = v_new,
      gb_used = 0,
      upstream_sub_user_id = null,
      upstream_username = null,
      upstream_password = null,
      activated_at = null,
      provision_username = null,
      provision_password = null,
      provision_attempts = 0,
      provisioning_claimed_at = null,
      provision_stalled_at = null,
      pending_reason = null,
      last_provision_error = null,
      upstream_missing_since = null,
      limit_sync_failed_since = null,
      limit_sync_alerted_at = null,
      exhausted_alerted_at = null,
      exhausted_email_due = false,
      low_alerted_pct = null,
      low_email_due = false,
      auto_topup_insufficient_alerted_at = null,
      usage_synced_at = null
  where id = p_credential_id;

  update public.bandwidth_accounts
  set archived_used_gb = archived_used_gb + v_used
  where user_id = c.user_id;

  return jsonb_build_object('gb_allocated', v_new, 'archived_gb', v_used);
end;
$$;

revoke all on function public.reprovision_credential(uuid, numeric) from public, anon, authenticated;
grant execute on function public.reprovision_credential(uuid, numeric) to service_role;

insert into public.schema_migrations (filename) values
  ('0079_proxy_lifecycle_pass3.sql')
on conflict do nothing;
