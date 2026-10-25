-- 0085_admin_section8_pass6.sql
--
-- Admin audit-log search, done in the database.
--
-- The page and the CSV export used to find "who" by looking up to 200 matching profile ids and
-- then putting them in the request URL twice (admin_id.in.(…),target_user_id.in.(…)) — about
-- 15 KB, past what the API gateway accepts, so a broad search ("gmail") failed with a misleading
-- "has migration 0043 been run?" banner, and was capped at 200 accounts even when it worked.
-- One function filters, joins the two e-mail addresses and pages the result, so the search is
-- complete and the URL stays short.
--
-- Safe to run against the live DB: idempotent.

create or replace function public.admin_audit_search(
  p_action text default null,
  p_user   uuid default null,
  p_who    text default null,
  p_from   timestamptz default null,
  p_to     timestamptz default null,   -- exclusive upper bound
  p_limit  integer default 50,
  p_offset integer default 0
)
returns table (
  id uuid, action text, target_ref text, target_user_id uuid, details jsonb, created_at timestamptz,
  admin_email text, target_email text, total_count bigint
)
language sql stable security definer set search_path = public, pg_temp as $$
  with matched as (
    select l.id, l.action, l.target_ref, l.target_user_id, l.details, l.created_at,
           a.email as admin_email, t.email as target_email
    from public.admin_audit_log l
    left join public.profiles a on a.id = l.admin_id
    left join public.profiles t on t.id = l.target_user_id
    where (coalesce(p_action, '') = '' or l.action ilike '%' || replace(replace(replace(p_action, '\', '\\'), '%', '\%'), '_', '\_') || '%')
      and (p_user is null or l.target_user_id = p_user)
      and (coalesce(p_who, '') = ''
           or a.email ilike '%' || replace(replace(replace(p_who, '\', '\\'), '%', '\%'), '_', '\_') || '%'
           or t.email ilike '%' || replace(replace(replace(p_who, '\', '\\'), '%', '\%'), '_', '\_') || '%')
      and (p_from is null or l.created_at >= p_from)
      and (p_to   is null or l.created_at <  p_to)
  )
  select m.id, m.action, m.target_ref, m.target_user_id, m.details, m.created_at,
         m.admin_email, m.target_email, count(*) over () as total_count
  from matched m
  order by m.created_at desc, m.id desc
  limit greatest(least(coalesce(p_limit, 50), 1000), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.admin_audit_search(text, uuid, text, timestamptz, timestamptz, integer, integer) from public, anon, authenticated;
grant execute on function public.admin_audit_search(text, uuid, text, timestamptz, timestamptz, integer, integer) to service_role;

insert into public.schema_migrations (filename) values
  ('0085_admin_section8_pass6.sql')
on conflict do nothing;
