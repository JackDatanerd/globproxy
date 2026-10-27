-- Proxy lifecycle pass 8.
-- 1. set_default_auto_topup gets the same upper bound as set_auto_topup (0059).
create or replace function public.set_default_auto_topup(
  p_user_id uuid, p_enabled boolean, p_threshold_gb numeric, p_amount_gb numeric
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_enabled then
    if p_threshold_gb is null or p_threshold_gb < 0 then
      raise exception 'threshold_gb must be 0 or greater';
    end if;
    if p_amount_gb is null or p_amount_gb <= 0 then
      raise exception 'amount_gb must be greater than 0';
    end if;
    if p_threshold_gb > 100000 or p_amount_gb > 100000 then
      raise exception 'threshold_gb and amount_gb cannot exceed 100000';
    end if;
    if p_amount_gb <= p_threshold_gb then
      raise exception 'amount_gb must be greater than threshold_gb';
    end if;
  end if;

  update public.bandwidth_accounts
  set default_auto_topup_enabled = p_enabled,
      default_auto_topup_threshold_gb = case when p_enabled then p_threshold_gb else null end,
      default_auto_topup_amount_gb = case when p_enabled then p_amount_gb else null end
  where user_id = p_user_id;

  if not found then
    raise exception 'Bandwidth account not found' using errcode = 'P0002';
  end if;
end;
$$;
revoke all on function public.set_default_auto_topup(uuid, boolean, numeric, numeric) from public, anon, authenticated;
grant execute on function public.set_default_auto_topup(uuid, boolean, numeric, numeric) to service_role;

-- 2. Whitelist mirror replaced atomically (the row lock serialises concurrent writers).
create or replace function public.replace_whitelist_mirror(
  p_credential_id uuid, p_user_id uuid, p_entries jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform 1 from public.proxy_credentials where id = p_credential_id and user_id = p_user_id for update;
  if not found then
    raise exception 'Credential not found' using errcode = 'P0002';
  end if;
  delete from public.proxy_whitelist_entries where credential_id = p_credential_id;
  insert into public.proxy_whitelist_entries (credential_id, user_id, ip, description)
  select distinct on (e->>'ip') p_credential_id, p_user_id, e->>'ip', coalesce(left(e->>'description', 100), '')
  from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) e
  where e->>'ip' is not null;
end;
$$;
revoke all on function public.replace_whitelist_mirror(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.replace_whitelist_mirror(uuid, uuid, jsonb) to service_role;
