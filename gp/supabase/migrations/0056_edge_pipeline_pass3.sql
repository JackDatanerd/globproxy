-- ============================================================
-- 0056 — Edge & request pipeline, audit pass 3
-- ============================================================
-- Idempotent: safe to re-run. Apply AFTER 0055_edge_pipeline_closeout.sql.
--
--  * G5  cron_task_locks + claim_cron_task_lock() + release_cron_task_lock():
--        a scheduled task now takes a short lease before it runs, so a
--        */5 chain that overruns its tick can no longer start a second copy of
--        the same task on top of itself (two usage syncs, two provisioning
--        passes). The lease expires on its own, so a Worker that is killed
--        mid-run cannot wedge the task.
--
-- RLS on, NO policies: only the service role touches it.

create table if not exists public.cron_task_locks (
  task         text primary key,
  locked_until timestamptz not null,
  locked_at    timestamptz not null default now(),
  lock_token   text not null
);

alter table public.cron_task_locks enable row level security;
revoke all on table public.cron_task_locks from anon, authenticated;

-- Takes the lease when it is free or expired. Returns the token to release it
-- with, or NULL when another run still holds it. One statement, so two
-- concurrent callers cannot both win.
create or replace function public.claim_cron_task_lock(p_task text, p_lease_seconds integer, p_token text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_token text;
begin
  insert into public.cron_task_locks (task, locked_until, locked_at, lock_token)
  values (p_task, now() + make_interval(secs => greatest(p_lease_seconds, 1)), now(), p_token)
  on conflict (task) do update
     set locked_until = excluded.locked_until, locked_at = now(), lock_token = excluded.lock_token
   where public.cron_task_locks.locked_until <= now()
  returning lock_token into v_token;
  return v_token;
end;
$$;

-- Releases only the caller's own lease: a run that overran its lease must not
-- free a newer run's lock.
create or replace function public.release_cron_task_lock(p_task text, p_token text)
returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.cron_task_locks set locked_until = now() where task = p_task and lock_token = p_token;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'claim_cron_task_lock(text, integer, text)',
    'release_cron_task_lock(text, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

insert into public.schema_migrations (filename) values
  ('0056_edge_pipeline_pass3.sql')
on conflict do nothing;
