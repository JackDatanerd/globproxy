-- ─────────────────────────────────────────────────────────────────────
-- 0075 · Cron, account deletion & ops — independent pass
--
--  1. settle_released_credential(): closing a credential for a DELETED account
--     (self-service, admin, or the retry sweep) now settles the account's bandwidth
--     accounting exactly like deleting a session does (delete_own_credential):
--     unused GB goes back to the balance, consumed GB moves to archived_used_gb.
--     Tombstoned credentials used to keep their allocation (and keep counting in
--     used_gb) forever. Already-deleted accounts are back-filled below.
--  2. Account deletion cool-off: profiles.deletion_requested_at / deletion_scheduled_at
--     / deletion_reminder_sent_at, plus attempt + last-error bookkeeping for the hourly
--     'deletions' task, and deletion_cleanup_pending / deletion_cleanup_notes so a
--     deletion that finished with warnings (something sensitive still on disk, a
--     supplier sub-user that could not be released) is retried and visible instead of
--     existing only in a log line. A customer cannot write any of these directly
--     (the protect trigger below): scheduling goes through the step-up-protected route.
--
-- Idempotent. Apply BEFORE deploying: the deletion route and the hourly 'deletions'
-- task read these columns.
-- ─────────────────────────────────────────────────────────────────────

-- ── 1. Settling released credentials ─────────────────────────────────
alter table public.proxy_credentials add column if not exists settled_at timestamptz;

create or replace function public.settle_released_credential(
  p_credential_id uuid,
  p_live_used_gb numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c         public.proxy_credentials%rowtype;
  v_used    numeric;
  v_release numeric;
begin
  select * into c from public.proxy_credentials where id = p_credential_id for update;
  if not found then
    return jsonb_build_object('skipped', 'not_found');
  end if;
  if c.settled_at is not null then
    return jsonb_build_object('skipped', 'already_settled');
  end if;

  -- The larger of the live figure and the last synced one counts as consumed, so a
  -- failed or stale live read can never hand back too much (same rule as
  -- delete_own_credential).
  v_used    := greatest(coalesce(p_live_used_gb, 0), coalesce(c.gb_used, 0), 0);
  v_release := greatest(0, coalesce(c.gb_allocated, 0) - v_used);

  -- used_gb on the account is (live sessions' gb_used) + archived_used_gb, and a
  -- tombstoned credential is still 'suspended', so its own gb_used must leave the live
  -- sum in the same step it moves to the archive — otherwise it counts twice.
  update public.proxy_credentials
     set gb_allocated = 0, gb_used = 0, settled_at = now()
   where id = c.id;

  update public.bandwidth_accounts
     set allocated_gb     = greatest(0, allocated_gb - v_release),
         archived_used_gb = archived_used_gb + v_used
   where user_id = c.user_id;

  return jsonb_build_object('released_gb', v_release, 'archived_gb', v_used);
end;
$$;

revoke all on function public.settle_released_credential(uuid, numeric) from public, anon, authenticated;
grant execute on function public.settle_released_credential(uuid, numeric) to service_role;

-- Back-fill: credentials of accounts deleted BEFORE this migration. No live figure is
-- available any more, so the synced gb_used is what counts as consumed.
do $$
declare r record;
begin
  for r in
    select id from public.proxy_credentials
    where suspended_reason = 'deleted' and settled_at is null
  loop
    perform public.settle_released_credential(r.id, null);
  end loop;
end $$;

-- ── 2. Account deletion cool-off + cleanup bookkeeping ───────────────
alter table public.profiles add column if not exists deletion_requested_at      timestamptz;
alter table public.profiles add column if not exists deletion_scheduled_at      timestamptz;
alter table public.profiles add column if not exists deletion_reminder_sent_at  timestamptz;
alter table public.profiles add column if not exists deletion_attempts          integer not null default 0;
alter table public.profiles add column if not exists deletion_last_error        text;
alter table public.profiles add column if not exists deletion_cleanup_pending   boolean not null default false;
alter table public.profiles add column if not exists deletion_cleanup_notes     text;

create index if not exists profiles_deletion_scheduled_idx
  on public.profiles (deletion_scheduled_at) where deletion_scheduled_at is not null;
create index if not exists profiles_deletion_cleanup_idx
  on public.profiles (deleted_at) where deletion_cleanup_pending;

-- "Update own profile" has no column restriction, so without this a signed-in browser
-- could schedule its own deletion (skipping the step-up the route demands) or clear
-- the cleanup flag after a deletion. Service-role writes (auth.uid() is null) and
-- admins pass through, as in protect_payout_hold_reason().
create or replace function public.protect_deletion_columns()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return new; -- service-role client
  end if;
  if public.is_admin(auth.uid()) then
    return new;
  end if;
  new.deletion_requested_at     := old.deletion_requested_at;
  new.deletion_scheduled_at     := old.deletion_scheduled_at;
  new.deletion_reminder_sent_at := old.deletion_reminder_sent_at;
  new.deletion_attempts         := old.deletion_attempts;
  new.deletion_last_error       := old.deletion_last_error;
  new.deletion_cleanup_pending  := old.deletion_cleanup_pending;
  new.deletion_cleanup_notes    := old.deletion_cleanup_notes;
  return new;
end;
$$;
revoke all on function public.protect_deletion_columns() from public, anon, authenticated;

drop trigger if exists trg_protect_deletion_columns on public.profiles;
create trigger trg_protect_deletion_columns
  before update on public.profiles
  for each row execute function public.protect_deletion_columns();

insert into public.schema_migrations (filename) values
  ('0075_cron_deletion_ops.sql')
on conflict do nothing;
