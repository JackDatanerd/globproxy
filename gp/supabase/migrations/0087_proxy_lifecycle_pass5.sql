-- ─────────────────────────────────────────────────────────────────────
-- 0087 · Proxy lifecycle — independent pass 5
--
-- proxy_credentials.pending_since: when the session LAST entered 'pending'.
-- The stalled-provisioning notice measured "pending for 6h" from created_at, so a
-- long-lived session that was re-provisioned (reprovision_credential: active → pending)
-- was flagged on the very next cron tick and the customer was e-mailed "this is taking
-- longer than usual" about a session that had been pending for seconds. A trigger stamps
-- the column on every transition INTO 'pending' (covers insert-as-pending and re-provision
-- without redefining either); NULL (rows from before this migration) falls back to created_at.
--
-- Safe to run against the live DB: idempotent.
-- ─────────────────────────────────────────────────────────────────────

alter table public.proxy_credentials add column if not exists pending_since timestamptz;

create or replace function public.stamp_credential_pending_since()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status = 'pending' and (tg_op = 'INSERT' or old.status is distinct from 'pending') then
    new.pending_since := now();
  end if;
  return new;
end;
$$;

revoke all on function public.stamp_credential_pending_since() from public, anon, authenticated;

drop trigger if exists proxy_credentials_stamp_pending_since on public.proxy_credentials;
create trigger proxy_credentials_stamp_pending_since
  before insert or update of status on public.proxy_credentials
  for each row execute function public.stamp_credential_pending_since();

insert into public.schema_migrations (filename) values
  ('0087_proxy_lifecycle_pass5.sql')
on conflict do nothing;
