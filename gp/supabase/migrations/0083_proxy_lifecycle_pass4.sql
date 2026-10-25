-- ─────────────────────────────────────────────────────────────────────
-- 0083 · Proxy lifecycle — independent pass 4
--
--  1. The 100-session cap now also guards UPDATE of status. It used to fire on INSERT
--     only, so a customer could create 100 sessions, pause some, create more, and then
--     resume the paused ones past the cap (resume is an UPDATE suspended → active).
--  2. proxy_credentials.auto_topup_alert_kind: which auto-allocate notice is currently
--     being suppressed by auto_topup_insufficient_alerted_at. The three notices
--     (insufficient / partial / session_limit) shared ONE flag, so after one of them the
--     others were silently swallowed until the flag cleared.
-- ─────────────────────────────────────────────────────────────────────

create or replace function public.enforce_credential_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status not in ('active', 'pending') then
    return new;
  end if;
  -- Already counted (active/pending → active/pending): nothing new is being added.
  if tg_op = 'UPDATE' and old.status in ('active', 'pending') then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('proxy_credentials:' || new.user_id::text));
  if (select count(*) from public.proxy_credentials
      where user_id = new.user_id and status in ('active', 'pending') and id <> new.id) >= 100 then
    raise exception 'Session limit reached (100). Delete an unused session first.' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_credential_limit() from public, anon, authenticated;

drop trigger if exists proxy_credentials_enforce_limit on public.proxy_credentials;
create trigger proxy_credentials_enforce_limit
  before insert or update of status on public.proxy_credentials
  for each row execute function public.enforce_credential_limit();

alter table public.proxy_credentials
  add column if not exists auto_topup_alert_kind text;

insert into public.schema_migrations (filename) values
  ('0083_proxy_lifecycle_pass4.sql')
on conflict do nothing;
