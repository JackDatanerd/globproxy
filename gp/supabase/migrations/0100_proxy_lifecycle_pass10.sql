-- Proxy lifecycle pass 10.
-- bulk_update_credential_usage now reports, per row, the gb_used it REPLACED (read under a row lock)
-- next to the value it wrote. The usage sync credited usage_daily with (new - the gb_used it had read
-- minutes earlier, before a slow upstream fetch), so a refresh or a second sync that moved gb_used in
-- between made the same slice be credited twice. The caller now credits (new - replaced value), which
-- is exactly what this write changed. Rows are locked in id order so concurrent syncs cannot deadlock.
-- Old callers that ignore the result keep working; the app falls back to its own snapshot delta when
-- the result is empty (migration not yet applied).
drop function if exists public.bulk_update_credential_usage(jsonb);
create function public.bulk_update_credential_usage(updates jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r record;
  v_out jsonb := '[]'::jsonb;
begin
  for r in
    select pc.id, coalesce(pc.gb_used, 0) as prev, (u.e->>'gb_used')::numeric as gb
    from jsonb_array_elements(updates) as u(e)
    join public.proxy_credentials pc on pc.id = (u.e->>'id')::uuid
    order by pc.id
    for update of pc
  loop
    update public.proxy_credentials set gb_used = r.gb where id = r.id;
    v_out := v_out || jsonb_build_object('id', r.id, 'prev', r.prev, 'gb', r.gb);
  end loop;
  return v_out;
end;
$$;
revoke all on function public.bulk_update_credential_usage(jsonb) from public, anon, authenticated;
grant execute on function public.bulk_update_credential_usage(jsonb) to service_role;

insert into public.schema_migrations (filename) values
  ('0100_proxy_lifecycle_pass10.sql')
on conflict do nothing;
