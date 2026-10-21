-- ============================================================
-- 0055 — Edge & request pipeline close-out (section 1, audit pass 2)
-- ============================================================
-- Idempotent: safe to re-run. Apply AFTER 0054_api_integrations_closeout.sql.
--
--  * G2  cron_task_runs + record_cron_task_run() + claim_stale_cron_tasks():
--        every scheduled task now leaves a heartbeat (last run / last success /
--        last error / consecutive failures). A task that fails three runs in a
--        row, or stops running altogether, alerts the admin once per incident
--        instead of only writing to a log that rotates away. Before this only
--        the 'usage' task had a staleness watchdog.
--  * G4  csp_violations + record_csp_violation() + prune_csp_violations():
--        Content-Security-Policy-Report-Only reports are aggregated (one row
--        per directive / blocked URL / page, with a hit counter) so the policy
--        can actually be reviewed and promoted to enforcing. The table is
--        capped at 500 distinct rows so the public report endpoint cannot be
--        used to grow it.
--
-- Both tables have RLS on and NO policies: only the service role touches them.

-- ── G2: cron heartbeat ──────────────────────────────────────────────
create table if not exists public.cron_task_runs (
  task                 text primary key,
  last_run_at          timestamptz not null default now(),
  last_ok_at           timestamptz,
  last_error           text,
  last_error_at        timestamptz,
  consecutive_failures integer not null default 0,
  alerted_at           timestamptz,
  stale_alerted_at     timestamptz
);

alter table public.cron_task_runs enable row level security;
revoke all on table public.cron_task_runs from anon, authenticated;

-- Records one run. Returns TRUE when the admin should be alerted about a
-- failing task right now: three consecutive failures, at most once per 24h per
-- incident (the claim is a single UPDATE, so two concurrent failures cannot
-- both alert). A success resets the streak and re-arms both alerts.
create or replace function public.record_cron_task_run(p_task text, p_ok boolean, p_error text default null)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.cron_task_runs (task) values (p_task) on conflict (task) do nothing;

  if p_ok then
    update public.cron_task_runs
       set last_run_at = now(), last_ok_at = now(), consecutive_failures = 0,
           alerted_at = null, stale_alerted_at = null
     where task = p_task;
    return false;
  end if;

  update public.cron_task_runs
     set last_run_at = now(), last_error = left(coalesce(p_error, 'unknown error'), 500),
         last_error_at = now(), consecutive_failures = consecutive_failures + 1,
         stale_alerted_at = null
   where task = p_task;

  update public.cron_task_runs
     set alerted_at = now()
   where task = p_task
     and consecutive_failures >= 3
     and (alerted_at is null or alerted_at < now() - interval '24 hours');
  return found;
end;
$$;

-- Tasks whose last run is older than their allowed age (seconds, keyed by task
-- name) and that have not been reported yet. Claims them atomically so the
-- hourly check emails each stale task once per incident.
create or replace function public.claim_stale_cron_tasks(p_max_age_seconds jsonb)
returns table (task text, last_run_at timestamptz)
language sql security definer set search_path = public, pg_temp as $$
  update public.cron_task_runs r
     set stale_alerted_at = now()
   where r.stale_alerted_at is null
     and (p_max_age_seconds ->> r.task) is not null
     and r.last_run_at < now() - make_interval(secs => (p_max_age_seconds ->> r.task)::double precision)
  returning r.task, r.last_run_at;
$$;

-- ── G4: CSP report aggregation ──────────────────────────────────────
create table if not exists public.csp_violations (
  fingerprint   text primary key,
  directive     text not null,
  blocked       text not null,
  document      text not null,
  hits          integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create index if not exists csp_violations_last_seen_idx on public.csp_violations (last_seen_at desc);

alter table public.csp_violations enable row level security;
revoke all on table public.csp_violations from anon, authenticated;

create or replace function public.record_csp_violation(p_directive text, p_blocked text, p_document text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_directive text := left(coalesce(p_directive, ''), 200);
  v_blocked   text := left(coalesce(p_blocked, ''), 200);
  v_document  text := left(coalesce(p_document, ''), 200);
  v_fp        text := md5(v_directive || '|' || v_blocked || '|' || v_document);
begin
  -- Known row: just count it.
  update public.csp_violations set hits = hits + 1, last_seen_at = now() where fingerprint = v_fp;
  if found then return; end if;
  -- New row: only while the table is small, so a flood of made-up reports
  -- cannot grow it without bound.
  if (select count(*) from public.csp_violations) >= 500 then return; end if;
  insert into public.csp_violations (fingerprint, directive, blocked, document)
  values (v_fp, v_directive, v_blocked, v_document)
  on conflict (fingerprint) do update set hits = public.csp_violations.hits + 1, last_seen_at = now();
end;
$$;

create or replace function public.prune_csp_violations()
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_deleted integer;
begin
  delete from public.csp_violations where last_seen_at < now() - interval '30 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'record_cron_task_run(text, boolean, text)',
    'claim_stale_cron_tasks(jsonb)',
    'record_csp_violation(text, text, text)',
    'prune_csp_violations()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

insert into public.schema_migrations (filename) values
  ('0055_edge_pipeline_closeout.sql')
on conflict do nothing;
