-- Proxy lifecycle pass 11.
-- bulk_update_credential_usage gains an optional per-row "read_at" (when the usage figure was read
-- from the supplier). A row whose usage_synced_at is NEWER than that — a live refresh or a second
-- sync wrote a fresher reading while this run was still working — is skipped instead of being
-- overwritten with the older, lower figure (which the next sync then re-credited to usage_daily).
-- Rows without read_at behave exactly as before, so the app keeps working before this is applied.
drop function if exists public.bulk_update_credential_usage(jsonb);
create function public.bulk_update_credential_usage(updates jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r record;
  v_out jsonb := '[]'::jsonb;
begin
  for r in
    select pc.id, coalesce(pc.gb_used, 0) as prev, (u.e->>'gb_used')::numeric as gb,
           pc.usage_synced_at as synced_at, nullif(u.e->>'read_at', '')::timestamptz as read_at
    from jsonb_array_elements(updates) as u(e)
    join public.proxy_credentials pc on pc.id = (u.e->>'id')::uuid
    order by pc.id
    for update of pc
  loop
    if r.read_at is not null and r.synced_at is not null and r.synced_at > r.read_at then
      continue;
    end if;
    update public.proxy_credentials set gb_used = r.gb where id = r.id;
    v_out := v_out || jsonb_build_object('id', r.id, 'prev', r.prev, 'gb', r.gb);
  end loop;
  return v_out;
end;
$$;
revoke all on function public.bulk_update_credential_usage(jsonb) from public, anon, authenticated;
grant execute on function public.bulk_update_credential_usage(jsonb) to service_role;

insert into public.schema_migrations (filename) values
  ('0102_proxy_lifecycle_pass11.sql')
on conflict do nothing;
