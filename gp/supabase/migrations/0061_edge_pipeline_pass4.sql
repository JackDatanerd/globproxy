-- ============================================================
-- 0061 — Edge & request pipeline, audit pass 4
-- ============================================================
-- Idempotent: safe to re-run. Apply AFTER 0060_auth_mfa_pass4.sql.
--
--  * B2  record_csp_violation(): the table is capped at 500 rows, but once full
--        every NEW report was silently dropped. The report endpoint is public,
--        so a flood of made-up reports could fill the cap and keep genuine
--        violations out for as long as the flood kept the rows fresh. A full
--        table now EVICTS its least-hit, least-recently-seen row to make room,
--        so recurring (real) violations survive and new ones are always recorded.
--  * G3  claim_stale_cron_tasks(): a task with no cron_task_runs row at all
--        (its trigger never fired since it was added) was invisible to the
--        staleness check. Every task named in the age map now gets a row, dated
--        "first seen now", so it goes stale — and alerts once — if it never runs.

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
  -- New row. While the table is full, make room by dropping the row that has
  -- the fewest hits (oldest first) rather than refusing the new report.
  if (select count(*) from public.csp_violations) >= 500 then
    delete from public.csp_violations
     where fingerprint = (
       select fingerprint from public.csp_violations
        order by hits asc, last_seen_at asc
        limit 1
     );
  end if;
  insert into public.csp_violations (fingerprint, directive, blocked, document)
  values (v_fp, v_directive, v_blocked, v_document)
  on conflict (fingerprint) do update set hits = public.csp_violations.hits + 1, last_seen_at = now();
end;
$$;

create or replace function public.claim_stale_cron_tasks(p_max_age_seconds jsonb)
returns table (task text, last_run_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
begin
  -- A task that has never reported has no row to age. Give it one, dated now.
  insert into public.cron_task_runs (task, last_run_at)
  select k, now() from jsonb_object_keys(coalesce(p_max_age_seconds, '{}'::jsonb)) as k
  on conflict (task) do nothing;

  return query
  update public.cron_task_runs r
     set stale_alerted_at = now()
   where r.stale_alerted_at is null
     and (p_max_age_seconds ->> r.task) is not null
     and r.last_run_at < now() - make_interval(secs => (p_max_age_seconds ->> r.task)::double precision)
  returning r.task, r.last_run_at;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'record_csp_violation(text, text, text)',
    'claim_stale_cron_tasks(jsonb)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

insert into public.schema_migrations (filename) values
  ('0061_edge_pipeline_pass4.sql')
on conflict do nothing;
